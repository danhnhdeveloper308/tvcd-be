import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { GoogleSheetsService } from './google-sheets.service';
import { HTMSheetsService } from './htm/htm-sheets.service';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class GoogleSheetsListenerService implements OnModuleInit {
  private readonly logger = new Logger(GoogleSheetsListenerService.name);
  private previousData: Map<string, any> = new Map();
  private isListening = false;
  private lastCheckTime: number = 0; // Track last check time for rate limiting

  constructor(
    private configService: ConfigService,
    private websocketGateway: WebsocketGateway,
    private googleSheetsService: GoogleSheetsService,
  ) {}

  async onModuleInit() {
    // Start real-time monitoring when module initializes
    await this.startRealtimeMonitoring();
  }

  async startRealtimeMonitoring() {
    if (this.isListening) {
      this.logger.warn('Real-time monitoring already started');
      return;
    }

    this.isListening = true;

    // Initial data load
    await this.loadInitialData();
    
    // Start periodic checks (every 30 seconds instead of 5 minutes)
  }

  private async loadInitialData() {
    try {
      const data = await this.googleSheetsService.getProductionData('ALL');
      
      // Store initial data with maChuyenLine as key
      data.forEach(record => {
        if (record.maChuyenLine) {
          this.previousData.set(record.maChuyenLine, { 
            ...record, 
            checksum: this.calculateChecksum(record) 
          });
        }
      });

    } catch (error) {
      this.logger.error('Failed to load initial data:', error);
    }
  }

  // Check every 5 minutes during work hours, ONLY in active production blocks
  // Reduced from 2 minutes to 5 minutes to avoid Google Sheets quota limits
  @Cron('*/2 8-20 * * 1-6', {
    timeZone: 'Asia/Ho_Chi_Minh',
  }) // Every 5 minutes, 8AM-8PM, Monday-Saturday
  async checkForChanges() {
    if (!this.isListening) return;

    // Check if we're in an active production block (30 minutes after each production start time)
    const vietnamTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    
    if (!this.isInActiveProductionBlock(vietnamTime)) {
      return;
    }


    try {
      // Add rate limiting: Skip if last check was less than 4 minutes ago
      const now = Date.now();
      if (this.lastCheckTime && (now - this.lastCheckTime) < 240000) {
        return;
      }
      this.lastCheckTime = now;

      const currentData = await this.googleSheetsService.getProductionData('ALL');
      const changes: Array<{ maChuyenLine: string; type: 'updated' | 'new' | 'deleted'; data: any }> = [];

      // Check for updates and new records
      for (const record of currentData) {
        if (!record.maChuyenLine) continue;

        const previousRecord = this.previousData.get(record.maChuyenLine);
        const currentChecksum = this.calculateChecksum(record);

        if (!previousRecord) {
          // New record
          changes.push({ 
            maChuyenLine: record.maChuyenLine, 
            type: 'new', 
            data: record 
          });
          this.previousData.set(record.maChuyenLine, { ...record, checksum: currentChecksum });
        } else if (previousRecord.checksum !== currentChecksum) {
          // Updated record
          changes.push({ 
            maChuyenLine: record.maChuyenLine, 
            type: 'updated', 
            data: record 
          });
          this.previousData.set(record.maChuyenLine, { ...record, checksum: currentChecksum });
        }
      }

      // Check for deleted records
      const currentMaChuyenLines = new Set(currentData.map(r => r.maChuyenLine).filter(Boolean));
      for (const [maChuyenLine, previousRecord] of this.previousData.entries()) {
        if (!currentMaChuyenLines.has(maChuyenLine)) {
          changes.push({ 
            maChuyenLine, 
            type: 'deleted', 
            data: previousRecord 
          });
          this.previousData.delete(maChuyenLine);
        }
      }

      // Emit changes to WebSocket clients
      if (changes.length > 0) {
        
        for (const change of changes) {
          this.emitChange(change);
        }
        
        // Also emit summary update
        this.websocketGateway.broadcastSystemUpdate('data-refresh', {
          changesCount: changes.length,
          timestamp: new Date().toISOString()
        });
      } else {
        // Log every 10 minutes to reduce noise (only during active blocks)
        // if (vietnamTime.getMinutes() % 10 === 0) {
        //   this.logger.debug(`🔍 No changes detected in active block (VN time: ${vietnamTime.toLocaleTimeString()})`);
        // }
      }

    } catch (error) {
      this.logger.error('❌ Error checking for changes:', error);
    }
  }

  private async emitChange(change: { maChuyenLine: string; type: string; data: any }) {
    const { maChuyenLine, type, data } = change;
    
    // TV cache will be handled by the TV display service when needed
    // if (type === 'updated' || type === 'new') {
    //   this.logger.debug(`🔄 Data updated for ${maChuyenLine}`);
    // } else if (type === 'deleted') {
    //   this.logger.debug(`🗑️ Data deleted for ${maChuyenLine}`);
    // }
    
    // Emit to specific maChuyenLine subscribers (TV displays) với data structure đúng
    this.websocketGateway.emitMaChuyenLineUpdate(maChuyenLine, {
      maChuyenLine,
      data: {
        type,
        data: data, // Raw data record
        summary: this.calculateSummaryFromRecord(data), // Calculate summary
      },
      timestamp: new Date().toISOString()
    });
    
    // Also emit to factory-based subscribers if needed
    if (data.nhaMay) {
      this.websocketGateway.emitProductionUpdate(data.nhaMay, {
        type,
        maChuyenLine,
        data: {
          type,
          data: data,
          summary: this.calculateSummaryFromRecord(data),
        },
        timestamp: new Date().toISOString()
      });
    }
  }



  private calculateSummaryFromRecord(record: any): any {
    // Return ALL fields A-AS để frontend có thể update tất cả
    return {
      // Thông tin cơ bản (A-E)
      maChuyenLine: record.maChuyenLine || '',
      nhaMay: record.nhaMay || '',
      line: record.line || '',
      to: record.to || '',
      maHang: record.maHang || '',
      
      // Sản lượng và công việc (F-L)
      slth: record.slth || 0,
      congKh: record.congKh || 0,
      congTh: record.congTh || 0,
      pphKh: record.pphKh || 0,
      pphTh: record.pphTh || 0,
      phanTramHtPph: record.phanTramHtPph || 0,
      gioSx: record.gioSx || 0,
      pphThNew: record.pphThNew || 0, // Test field
      percentagePPHNew: record.percentagePPHNew || 0,
      percentageSLTHNew: record.percentageSLTHNew || 0,
      diffPercentagePPHNew: record.diffPercentagePPHNew || 0,
      diffPercentageSLTHNew: record.diffPercentageSLTHNew || 0,

      // Nhân lực (M-P)
      ldCoMat: record.ldCoMat || 0,
      ldLayout: record.ldLayout || 0,
      ldHienCo: record.ldHienCo || 0,
      nangSuat: record.nangSuat || 0,
      
      // PPH và Target (Q-W)
      pphTarget: record.pphTarget || 0,
      pphGiao: record.pphGiao || 0,
      phanTramGiao: record.phanTramGiao || 0,
      targetNgay: record.targetNgay || 0,
      targetGio: record.targetGio || 0,
      lkth: record.lkth || 0,
      phanTramHt: record.phanTramHt || 0,
      
      // Dữ liệu theo giờ (X-AH)
      // h830: record.h830 || 0,
      // h930: record.h930 || 0,
      // h1030: record.h1030 || 0,
      // h1130: record.h1130 || 0,
      // h1330: record.h1330 || 0,
      // h1430: record.h1430 || 0,
      // h1530: record.h1530 || 0,
      // h1630: record.h1630 || 0,
      // h1800: record.h1800 || 0,
      // h1900: record.h1900 || 0,
      // h2000: record.h2000 || 0,

      // // %Dữ liệu theo giờ(AI-AS)
      // percentageh830: record.percentageh830 || 0,
      // percentageh930: record.percentageh930 || 0,
      // percentageh1030: record.percentageh1030 || 0,
      // percentageh1130: record.percentageh1130 || 0,
      // percentageh1330: record.percentageh1330 || 0,
      // percentageh1430: record.percentageh1430 || 0,
      // percentageh1530: record.percentageh1530 || 0,
      // percentageh1630: record.percentageh1630 || 0,
      // percentageh1800: record.percentageh1800 || 0,
      // percentageh1900: record.percentageh1900 || 0,
      // percentageh2000: record.percentageh2000 || 0,
      
      // Hourly data object with RFT data
      hourlyData: this.processHourlyDataForSocket(record.hourlyData || {}),
      
      // Thông tin bổ sung (AT-AX)
      lean: record.lean || '',
      phanTram100: record.phanTram100 || 0,
      t: record.t || 0,
      l: record.l || 0,
      image: record.image || '',
      
      // Chỉ số chất lượng (AY-BD)
      lkkh: record.lkkh || 0,
      bqTargetGio: record.bqTargetGio || 0,
      slcl: record.slcl || 0,
      rft: record.rft || 0,
      tongKiem: record.tongKiem || 0,
      mucTieuRft: record.mucTieuRft || 0,

      // Additional fields (newly added) (BE-BH)
      lktuiloi: record.lktuiloi || 0,       // BE: LKTUỈ LỖI
      nhipsx: record.nhipsx || 0,          // BF: NHỊP SX
      tansuat: record.tansuat || 0,        // BG: TẦN SỬAT
      tyleloi: record.tyleloi || 0,        // BH: TỶ LỆ LỖI
      QCTarget: record.QCTarget || 0,                // BO: QC TARGET
      
      // Các trường diff/so sánh tỷ lệ (calculated fields)
      diffLdCoMatLayout: record.diffLdCoMatLayout || 0,        // 1. Diff ldCoMat vs ldLayout
      diffLkthTarget: record.diffLkthTarget || 0,              // 2. Diff lkth vs targetNgay
      diffRftTarget: record.diffRftTarget || 0,                // 3. RFT so với 92%
      diffBqTargetSlcl: record.diffBqTargetSlcl || 0,          // 4. bqTargetGio so với slcl
      ratioPphThKh: record.ratioPphThKh || 0,                  // 5. Tỷ lệ pphTh/pphKh
      ratioPphThKhNew: record.ratioPphThKhNew || 0,        // Test field
      diffPhanTramHt100: record.diffPhanTramHt100 || 0,        // 6. %HT so với 100%
      diffPhanTramHtPph100: record.diffPhanTramHtPph100 || 0,  // 7. %HT PPH so với 100%
      
      // Compatibility fields
      actual_quantity: record.slth || record.actual_quantity || 0,
      targetDay: record.targetNgay || 0,

      tongDat: record.tongDat || 0, // Thêm trường TỔNG ĐẠT
      tuiChuaTaiChe: record.tuiChuaTaiChe || 0, // Thêm trường TÚI CHỨA TÁI CHẾ
      tuiChuaTaiCheNew: record.tuiChuaTaiCheNew || 0, // For comparison testing

      thoigianlamviec: record.thoigianlamviec || 0, // CL: THỜI GIAN LÀM VIỆC
      tongKiemNew: record.tongKiemNew || 0, // For comparison testing
      tongDatNew: record.tongDatNew || 0,   // For comparison testing
      tongLoiNew: record.tongLoiNew || 0,   // For comparison testing

      // Metadata
      _lastSocketUpdate: Date.now(),
      _renderKey: Date.now(),
    };
  }

  private calculateChecksum(record: any): string {
    // Calculate checksum based on ALL fields A-AS for comprehensive change detection
    const allFields = this.getAllFieldsToMonitor();
    
    // Get values for all monitored fields
    const fieldValues = allFields.map(field => {
      const value = record[field];
      // Handle different types consistently
      if (value === null || value === undefined) return 'null';
      if (typeof value === 'number') return value.toString();
      if (typeof value === 'boolean') return value.toString();
      return String(value).trim();
    }).join('|');
    
    // CRITICAL: Add ALL hourly data fields to checksum including RFT errors
    const hourlyValues = this.serializeHourlyDataForChecksum(record.hourlyData || {});
    
    return Buffer.from(fieldValues + '|' + hourlyValues).toString('base64');
  }

  // Serialize hourly data including ALL RFT error fields for comprehensive change detection
  private serializeHourlyDataForChecksum(hourlyData: any): string {
    if (!hourlyData || typeof hourlyData !== 'object') {
      return '';
    }

    const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
    const checksumParts: string[] = [];

    timeSlots.forEach(slot => {
      const slotData = hourlyData[slot];
      if (slotData && typeof slotData === 'object') {
        // Include ALL fields: sanluong, percentage, rft, tongKiem, datLan1, tongDat, loi1-14, errorpercentage1-14
        const fields = [
          'sanluong', 'percentage', 'rft', 'tongKiem', 'datLan1', 'tongDat',
          'loi1', 'loi2', 'loi3', 'loi4', 'loi5', 'loi6', 'loi7', 'loi8', 'loi9', 'loi10',
          'loi11', 'loi12', 'loi13', 'loi14',
          'errorpercentage1', 'errorpercentage2', 'errorpercentage3', 'errorpercentage4',
          'errorpercentage5', 'errorpercentage6', 'errorpercentage7', 'errorpercentage8',
          'errorpercentage9', 'errorpercentage10', 'errorpercentage11', 'errorpercentage12',
          'errorpercentage13', 'errorpercentage14'
        ];
        
        const slotChecksum = fields.map(f => String(slotData[f] || 0)).join(',');
        checksumParts.push(`${slot}:${slotChecksum}`);
      }
    });

    return checksumParts.join('|');
  }

  // Comprehensive field monitoring for all columns A-AS
  private getAllFieldsToMonitor(): string[] {
    return [
      // Thông tin cơ bản (A-E)
      'maChuyenLine', 'nhaMay', 'line', 'to', 'maHang',
      
      // Sản lượng và công việc (F-L)
      'slth', 'congKh', 'congTh', 'pphKh', 'pphTh', 'phanTramHtPph', 'gioSx',
      
      // Nhân lực (M-P)
      'ldCoMat', 'ldLayout', 'ldHienCo', 'nangSuat',
      
      // PPH và Target (Q-W)
      'pphTarget', 'pphGiao', 'phanTramGiao', 'targetNgay', 'targetGio', 'lkth', 'phanTramHt',
      
      // Dữ liệu theo giờ (X-AH)
      'h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000',

      // null hourlyData object (AI-AS)
      'percentageh830', 'percentageh930', 'percentageh1030', 'percentageh1130', 'percentageh1330', 'percentageh1430', 'percentageh1530', 'percentageh1630', 'percentageh1800', 'percentageh1900', 'percentageh2000',

      // Thông tin bổ sung (AT-AX)
      'lean', 'phanTram100', 't', 'l', 'image',
      
      // Chỉ số chất lượng (AY-BD)
      'lkkh', 'bqTargetGio', 'slcl', 'rft', 'tongKiem', 'mucTieuRft'

      // Additional fields (BE-BH)
      , 'lktuiloi', 'nhipsx', 'tansuat', 'tyleloi', 'loikeo', 'loison', 'loichi', 'phanTramLoiKeo', 'phanTramLoiSon', 'phanTramLoiChi', 'QCTarget',


      // 'loi4', 'loi5', 'loi6', 'loi7', 'loi8', 'loi9', 'loi10', 'loi11', 'loi12', 'loi13', 'loi14',
      // 'phanTramLoi4', 'phanTramLoi5', 'phanTramLoi6', 'phanTramLoi7', 'phanTramLoi8', 'phanTramLoi9', 'phanTramLoi10', 'phanTramLoi11', 'phanTramLoi12', 'phanTramLoi13', 'phanTramLoi14',
    ];
  }

  // Enhanced change detection for all fields
  private detectFieldChanges(currentRecord: any, previousRecord: any): { hasChanges: boolean, changedFields: any[] } {
    const changedFields = [];
    const fieldsToMonitor = this.getAllFieldsToMonitor();
    
    for (const field of fieldsToMonitor) {
      const currentValue = currentRecord[field];
      const previousValue = previousRecord[field];
      
      // Handle different value types and null/undefined cases
      if (this.isValueChanged(currentValue, previousValue)) {
        changedFields.push({
          field,
          oldValue: previousValue,
          newValue: currentValue,
          column: this.getColumnLetter(field)
        });
      }
    }
    
    return {
      hasChanges: changedFields.length > 0,
      changedFields
    };
  }

  // Helper to determine if a value has actually changed
  private isValueChanged(currentValue: any, previousValue: any): boolean {
    // Handle null/undefined cases
    if (currentValue == null && previousValue == null) return false;
    if (currentValue == null || previousValue == null) return true;
    
    // Handle number comparisons (for percentages, quantities, etc.)
    if (typeof currentValue === 'number' && typeof previousValue === 'number') {
      return Math.abs(currentValue - previousValue) > 0.01; // Small tolerance for floating point
    }
    
    // Handle string comparisons
    if (typeof currentValue === 'string' && typeof previousValue === 'string') {
      return currentValue.trim() !== previousValue.trim();
    }
    
    // Default comparison
    return currentValue !== previousValue;
  }

  // Map field names to column letters for debugging
  private getColumnLetter(fieldName: string): string {
    const columnMap: { [key: string]: string } = {
      'maChuyenLine': 'A', 'nhaMay': 'B', 'line': 'C', 'to': 'D', 'maHang': 'E',
      'slth': 'F', 'congKh': 'G', 'congTh': 'H', 'pphKh': 'I', 'pphTh': 'J', 'phanTramHtPph': 'K', 'gioSx': 'L',
      'ldCoMat': 'M', 'ldLayout': 'N', 'ldHienCo': 'O', 'nangSuat': 'P',
      'pphTarget': 'Q', 'pphGiao': 'R', 'phanTramGiao': 'S', 'targetNgay': 'T', 'targetGio': 'U', 'lkth': 'V', 'phanTramHt': 'W',
      'h830': 'X', 'h930': 'Y', 'h1030': 'Z', 'h1130': 'AA', 'h1330': 'AB', 'h1430': 'AC', 'h1530': 'AD', 'h1630': 'AE', 'h1800': 'AF', 'h1900': 'AG', 'h2000': 'AH',
      'lean': 'AT', 'phanTram100': 'AU', 't': 'AV', 'l': 'AW', 'image': 'AX',
      // '': 'AI', '': 'AJ', '': 'AK', '': 'AL', '': 'AM', '': 'AN', '': 'AO', '': 'AP', '': 'AQ', '': 'AR', '': 'AS',
      'percentageh830': 'AI', 'percentageh930': 'AJ', 'percentageh1030': 'AK', 'percentageh1130': 'AL', 'percentageh1330': 'AM', 'percentageh1430': 'AN', 'percentageh1530': 'AO', 'percentageh1630': 'AP', 'percentageh1800': 'AQ', 'percentageh1900': 'AR', 'percentageh2000': 'AS',
      'lkkh': 'AY', 'bqTargetGio': 'AZ', 'slcl': 'BA', 'rft': 'BB', 'tongKiem': 'BC', 'mucTieuRft': 'BD',
      'lktuiloi': 'BE', 'nhipsx': 'BF', 'tansuat': 'BG', 'tyleloi': 'BH',
      'loikeo': 'BI', 'loison': 'BJ', 'loichi': 'BK',
      'phanTramLoiKeo': 'BL', 'phanTramLoiSon': 'BM', 'phanTramLoiChi': 'BN', 'QCTarget': 'BO',

      // 'loi4': 'BP', 'loi5': 'BQ', 'loi6': 'BR', 'loi7': 'BS', 'loi8': 'BT', 'loi9': 'BU', 'loi10': 'BV', 'loi11': 'BW', 'loi12': 'BX', 'loi13': 'BY', 'loi14': 'BZ',
      // 'phanTramLoi4': 'CA', 'phanTramLoi5': 'CB', 'phanTramLoi6': 'CC', 'phanTramLoi7': 'CD', 'phanTramLoi8': 'CE', 'phanTramLoi9': 'CF', 'phanTramLoi10': 'CG', 'phanTramLoi11': 'CH', 'phanTramLoi12': 'CI', 'phanTramLoi13': 'CJ', 'phanTramLoi14': 'CK',
    };
    return columnMap[fieldName] || 'Unknown';
  }

  // Process hourlyData for socket emission with RFT data
  private processHourlyDataForSocket(hourlyData: any): any {
    if (!hourlyData || typeof hourlyData !== 'object') {
      return {};
    }

    const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
    const processedData: any = {};

    timeSlots.forEach(slot => {
      const slotData = hourlyData[slot];
      
      if (slotData && typeof slotData === 'object') {
        processedData[slot] = {
          sanluong: slotData.sanluong || 0,
          percentage: slotData.percentage || 0,
          sanluongNew: slotData.sanluongNew || 0, // TEST field
          percentageNew: slotData.percentageNew || 0, // TEST field
          tongKiemV2: slotData.tongKiemV2 || 0,
          rft: slotData.rft || 0,
          tongKiem: slotData.tongKiem || 0,
          datLan1: slotData.datLan1 || 0,
          tongDat: slotData.tongDat || 0,
          tuiChuaTaiChe: slotData.tuiChuaTaiChe || 0,
          tuiChuaTaiCheNew: slotData.tuiChuaTaiCheNew || 0,
          loi1: slotData.loi1 || 0,
          loi2: slotData.loi2 || 0,
          loi3: slotData.loi3 || 0,
          loi4: slotData.loi4 || 0,
          loi5: slotData.loi5 || 0,
          loi6: slotData.loi6 || 0,
          loi7: slotData.loi7 || 0,
          loi8: slotData.loi8 || 0,
          loi9: slotData.loi9 || 0,
          loi10: slotData.loi10 || 0,
          loi11: slotData.loi11 || 0,
          loi12: slotData.loi12 || 0,
          loi13: slotData.loi13 || 0,
          loi14: slotData.loi14 || 0,
          errorpercentage1: slotData.errorpercentage1 || 0,
          errorpercentage2: slotData.errorpercentage2 || 0,
          errorpercentage3: slotData.errorpercentage3 || 0,
          errorpercentage4: slotData.errorpercentage4 || 0,
          errorpercentage5: slotData.errorpercentage5 || 0,
          errorpercentage6: slotData.errorpercentage6 || 0,
          errorpercentage7: slotData.errorpercentage7 || 0,
          errorpercentage8: slotData.errorpercentage8 || 0,
          errorpercentage9: slotData.errorpercentage9 || 0,
          errorpercentage10: slotData.errorpercentage10 || 0,
          errorpercentage11: slotData.errorpercentage11 || 0,
          errorpercentage12: slotData.errorpercentage12 || 0,
          errorpercentage13: slotData.errorpercentage13 || 0,
          errorpercentage14: slotData.errorpercentage14 || 0,
        };
      } else {
        processedData[slot] = {
          sanluong: 0,
          percentage: 0,
          sanluongNew: 0, // TEST field
          percentageNew: 0, // TEST field
          tongKiemV2: 0,
          rft: 0,
          tongKiem: 0,
          datLan1: 0,
          tongDat: 0,
          tuiChuaTaiChe: 0,
          tuiChuaTaiCheNew: 0,
          loi1: 0, loi2: 0, loi3: 0, loi4: 0, loi5: 0, loi6: 0, loi7: 0,
          loi8: 0, loi9: 0, loi10: 0, loi11: 0, loi12: 0, loi13: 0, loi14: 0,
          errorpercentage1: 0, errorpercentage2: 0, errorpercentage3: 0, errorpercentage4: 0,
          errorpercentage5: 0, errorpercentage6: 0, errorpercentage7: 0, errorpercentage8: 0,
          errorpercentage9: 0, errorpercentage10: 0, errorpercentage11: 0, errorpercentage12: 0,
          errorpercentage13: 0, errorpercentage14: 0,
        };
      }
    });

    return processedData;
  }

  // Define active production blocks (times when production data changes frequently)
  private getActiveProductionBlocks(): string[] {
    return [
      "08:30", // Start of shift 1
      "09:30", // Mid-morning check
      "10:30", // Late morning
      "11:30", // Pre-lunch
      "13:30", // Start after lunch
      "14:30", // Mid-afternoon
      "15:30", // Late afternoon
      "16:30", // End of shift 1
      "18:00", // Start of shift 2
      "19:00", // Mid-evening
      "20:00",  // End of shift 2

      //testing blocks
      "09:00",
      "10:00",
      "11:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
    ];
  }

  // Check if current time is within 30 minutes after any production block start
  private isInActiveProductionBlock(date: Date): boolean {
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    const activeBlocks = this.getActiveProductionBlocks();

    return activeBlocks.some((block) => {
      const [h, m] = block.split(":").map(Number);
      const start = h * 60 + m;
      const end = start + 30; // Active for 30 minutes after block start
      return nowMinutes >= start && nowMinutes < end;
    });
  }

  stopRealtimeMonitoring() {
    this.isListening = false;
    this.previousData.clear();
  }

  getMonitoringStats() {
    return {
      isListening: this.isListening,
      trackedRecords: this.previousData.size,
      lastCheck: new Date().toISOString()
    };
  }
}