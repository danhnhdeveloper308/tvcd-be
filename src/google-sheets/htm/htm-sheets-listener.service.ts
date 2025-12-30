import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { WebsocketGateway } from '../../websocket/websocket.gateway';
import { HTMSheetsService } from './htm-sheets.service';

@Injectable()
export class HTMSheetsListenerService implements OnModuleInit {
  private readonly logger = new Logger(HTMSheetsListenerService.name);
  private previousData: Map<string, any> = new Map(); // Key: maChuyenLine_index
  private isListening = false;
  private lastCheckTime: number = 0;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => WebsocketGateway))
    private websocketGateway: WebsocketGateway,
    private htmSheetsService: HTMSheetsService,
  ) {}

  async onModuleInit() {
    await this.startRealtimeMonitoring();
  }

  async startRealtimeMonitoring() {
    if (this.isListening) {
      this.logger.warn('HTM Sheets monitoring already started');
      return;
    }

    this.isListening = true;
    // this.logger.log('🚀 HTM Sheets: Real-time monitoring started');

    await this.loadInitialData();
  }

  private async loadInitialData() {
    // ⚡ OPTIMIZATION: Don't load all data on startup to avoid quota issues
    // Data will be loaded on-demand when clients subscribe
    // this.logger.log('📦 HTM Sheets: Listener initialized (on-demand loading mode)');
  }
  
  // On-demand data loading when a specific line is requested
  async loadLineData(maChuyenLine: string, factory: string, index: number): Promise<void> {
    const key = `${maChuyenLine}_${index}`;
    
    // Skip if already loaded
    if (this.previousData.has(key)) {
      return;
    }
    
    try {
      const mergedData = await this.htmSheetsService.getProductionDataWithEndlineMerge(
        maChuyenLine,
        factory,
        index
      );
      
      if (mergedData) {
        this.previousData.set(key, {
          data: mergedData,
          checksum: this.calculateChecksum(mergedData)
        });
        // this.logger.log(`✅ HTM Sheets: Loaded on-demand data for ${key}`);
      }
    } catch (error) {
      this.logger.warn(`⚠️ HTM Sheets: Failed to load ${key}:`, error.message);
    }
  }

  // 🚀 CONFIGURABLE: Cron schedule via env variable to stagger checks across servers
  // TS1 (.env.ts1): HTM_CRON_SCHEDULE="0-58/2 7-21 * * 1-6" (even minutes: 00, 02, 04...)
  // TS2 (.env.ts2): HTM_CRON_SCHEDULE="1-59/2 7-21 * * 1-6" (odd minutes: 01, 03, 05...)
  // TS3 (.env.ts3): HTM_CRON_SCHEDULE="*/3 7-21 * * 1-6" (every 3 min: 00, 03, 06...)
  // Default: Every 2 minutes during work hours (7AM-9PM, Mon-Sat)
  @Cron(process.env.HTM_CRON_SCHEDULE || '*/2 7-21 * * 1-6', {
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async checkForChanges() {
    if (!this.isListening) return;

    const vietnamTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const timeStr = vietnamTime.toLocaleTimeString('vi-VN');
    
    this.logger.log(`⏰ HTM Sheets: Cron triggered at ${timeStr} (2-minute staggered interval)`);

    // Prevent too frequent checks
    const now = Date.now();
    if (this.lastCheckTime && (now - this.lastCheckTime) < 90000) { // Min 90 seconds between checks
      this.logger.debug(`⏭️ HTM Sheets: Skipping check (last check was ${Math.floor((now - this.lastCheckTime) / 1000)}s ago)`);
      return;
    }
    this.lastCheckTime = now;

    this.logger.log(`🔍 HTM Sheets: Starting change detection from BOTH sheets (DATA BCSL HTM + ENDLINE)...`);
    await this.performCheck();
  }
  
  // Helper to extract factory from maChuyenLine
  private extractFactoryFromMaChuyenLine(maChuyenLine: string): string | null {
    if (!maChuyenLine) return null;
    
    const match = maChuyenLine.match(/KVHB07M(\d+)/);
    if (match) {
      const lineNumber = parseInt(match[1]);
      
      if (lineNumber >= 1 && lineNumber <= 14) {
        return 'TS1';
      } else if (lineNumber >= 18 && lineNumber <= 24) {
        return 'TS2';
      } else if (lineNumber >= 25 && lineNumber <= 38) {
        return 'TS3';
      }
    }
    
    return null;
  }

  private async emitChange(change: { key: string; type: string; data: any }) {
    const { key, type, data } = change;
    const maChuyenLine = data.maChuyenLine;
    
    // this.logger.log(`📡 HTM Sheets: Emitting ${type} for ${maChuyenLine}`);
    
    // Emit to maChuyenLine subscribers (TV displays)
    this.websocketGateway.emitMaChuyenLineUpdate(maChuyenLine, {
      maChuyenLine,
      lineType: 'HTM',
      data: {
        type,
        data: data,
        summary: this.calculateSummaryFromRecord(data),
      },
      timestamp: new Date().toISOString()
    });
    
    // Also emit to factory channel
    if (data.nhaMay) {
      this.websocketGateway.emitProductionUpdate(data.nhaMay, {
        type,
        maChuyenLine,
        lineType: 'HTM',
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
    return {
      maChuyenLine: record.maChuyenLine || '',
      nhaMay: record.nhaMay || '',
      line: record.line || '',
      to: record.to || '',
      maHang: record.maHang || '',
      
      // Production metrics
      slth: record.slth || 0,
      targetNgay: record.targetNgay || 0,
      targetGio: record.targetGio || 0,
      lkkh: record.lkkh || 0,
      lkth: record.lkth || 0,
      phanTramHt: record.phanTramHt || 0,
      diffLkthTarget: record.diffLkthTarget || 0,
      diffPhanTramHt100: record.diffPhanTramHt100 || 0,
      
      // PPH metrics
      pphKh: record.pphKh || 0,
      pphTh: record.pphTh || 0,
      phanTramHtPph: record.phanTramHtPph || 0,
      ratioPphThKh: record.ratioPphThKh || 0,
      diffPhanTramHtPph100: record.diffPhanTramHtPph100 || 0,
      
      // Labor metrics
      ldLayout: record.ldLayout || 0,
      ldCoMat: record.ldCoMat || 0,
      diffLdCoMatLayout: record.diffLdCoMatLayout || 0,
      thoigianlamviec: record.thoigianlamviec || 0,
      
      // QC metrics (from ENDLINE merge)
      tongKiem: record.tongKiem || 0,
      datLan1: record.datLan1 || 0,
      tongDat: record.tongDat || 0,
      tongLoi: record.tongLoi || 0,
      rft: record.rft || 0,
      diffRftTarget: record.diffRftTarget || 0,
      
      // Error fields (loi1-14 from ENDLINE)
      loi1: record.loi1 || 0,
      loi2: record.loi2 || 0,
      loi3: record.loi3 || 0,
      loi4: record.loi4 || 0,
      loi5: record.loi5 || 0,
      loi6: record.loi6 || 0,
      loi7: record.loi7 || 0,
      loi8: record.loi8 || 0,
      loi9: record.loi9 || 0,
      loi10: record.loi10 || 0,
      loi11: record.loi11 || 0,
      loi12: record.loi12 || 0,
      loi13: record.loi13 || 0,
      loi14: record.loi14 || 0,
      
      // Hourly data
      hourlyData: record.hourlyData || {},
      
      // Image
      image: record.image || '',
      
      _lastSocketUpdate: Date.now(),
    };
  }

  private calculateChecksum(record: any): string {
    // 🚀 COMPREHENSIVE: Include ALL fields from DATA BCSL HTM + ENDLINE sheets
    const fields = [
      // ===== DATA BCSL HTM SHEET (Columns A-CO) =====
      // Basic info (A-E)
      'maChuyenLine', 'nhaMay', 'line', 'to', 'maHang',
      // Production metrics (F-L)
      'slth', 'congKh', 'congTh', 'pphKh', 'pphTh', 'phanTramHtPph', 'gioSx',
      // Labor metrics (M-P)
      'ldLayout', 'ldCoMat', 'ldHienCo', 'nangSuat',
      // Targets (Q-W)
      'pphTarget', 'pphGiao', 'phanTramGiao', 'targetNgay', 'targetGio', 'lkkh', 'lkth', 'phanTramHt',
      // Time metrics
      'thoigianlamviec',
      // Additional metrics
      'image', 'lean', 'bqTargetGio', 'slcl', 'lktuiloi',
      // Calculated fields
      'diffLdCoMatLayout', 'diffLkthTarget', 'diffPhanTramHt100', 'diffPhanTramHtPph100',
      'ratioPphThKh', 'pphThNew', 'percentagePPHNew', 'percentageSLTHNew',
      
      // ===== ENDLINE SHEET (BEFORE_DATA / DAILY_DATA) =====
      // QC Summary metrics
      'tongKiem', 'datLan1', 'tongDat', 'tongLoi', 'rft', 'diffRftTarget',
      // Error detail fields (loi1-loi14)
      'loi1', 'loi2', 'loi3', 'loi4', 'loi5', 'loi6', 'loi7',
      'loi8', 'loi9', 'loi10', 'loi11', 'loi12', 'loi13', 'loi14',
      // Error percentages
      'errorpercentage1', 'errorpercentage2', 'errorpercentage3', 'errorpercentage4',
      'errorpercentage5', 'errorpercentage6', 'errorpercentage7', 'errorpercentage8',
      'errorpercentage9', 'errorpercentage10', 'errorpercentage11', 'errorpercentage12',
      'errorpercentage13', 'errorpercentage14',
      // Bag metrics from ENDLINE
      'tuiChuaTaiChe', 'tuiChuaTaiCheNew',
      
      // ===== METADATA =====
      '_endlineSheet', '_debug', 'lastUpdate'
    ];
    
    const fieldValues = fields.map(field => {
      const value = record[field];
      // Convert to string, handle numbers properly
      return value !== undefined && value !== null ? String(value) : '';
    }).join('|');
    
    // Include hourly data from BOTH sheets
    const hourlyValues = this.serializeHourlyData(record.hourlyData || {});
    
    // Include debug info to detect sheet switching (BEFORE → DAILY at 8:30 AM)
    const metaValues = [
      record._debug?.endlineSheetSource || '',
      record._debug?.selectedSheetName || '',
      record._debug?.selectedSheetRange || ''
    ].join('|');
    
    // ✅ OPTIMIZED: ENDLINE data is already in main fields (tongKiem, rft, loi1-14, etc.)
    // No need for separate _bothEndlineSheets data since getProductionDataWithEndlineMerge
    // already merges ENDLINE fields into the record
    
    return Buffer.from(
      fieldValues + '|' + 
      hourlyValues + '|' + 
      metaValues
    ).toString('base64');
  }

  /**
   * Serialize ENDLINE sheet data (ALL columns A:AJ) into checksum string
   */
  private serializeEndlineSheetData(sheetData: any): string {
    if (!sheetData) return '';
    
    const fields = [
      'nhaMay', 'line', 'col16', 'col1', 'to',
      'tongKiem', 'datLan1', 'tongDat',
      'loi1', 'loi2', 'loi3', 'loi4', 'loi5', 'loi6', 'loi7',
      'loi8', 'loi9', 'loi10', 'loi11', 'loi12', 'loi13', 'loi14',
      'rft',
      'h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000',
      'duLieu', 'nguyenNhan'
    ];
    
    return fields.map(f => {
      const value = sheetData[f];
      return value !== undefined && value !== null ? String(value) : '';
    }).join(',');
  }

  private serializeHourlyData(hourlyData: any): string {
    if (!hourlyData || typeof hourlyData !== 'object') {
      return '';
    }

    const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
    const checksumParts: string[] = [];

    timeSlots.forEach(slot => {
      const slotData = hourlyData[slot];
      if (slotData && typeof slotData === 'object') {
        // 🚀 COMPREHENSIVE: Include ALL fields from BOTH sheets (DATA BCSL HTM + ENDLINE)
        const fields = [
          // ===== From DATA BCSL HTM hourly columns (X-AH) =====
          'sanluong', 'percentage', 'sanluongNew', 'percentageNew',
          
          // ===== From ENDLINE RFT data (hourly breakdown) =====
          'rft', 'tongKiem', 'tongKiemNew', 'datLan1', 'tongDat', 'tongLoi',
          'tuiChuaTaiChe', 'tuiChuaTaiCheNew',
          
          // ===== Error counts from ENDLINE (loi1-loi14) =====
          'loi1', 'loi2', 'loi3', 'loi4', 'loi5', 'loi6', 'loi7',
          'loi8', 'loi9', 'loi10', 'loi11', 'loi12', 'loi13', 'loi14',
          
          // ===== Error percentages from ENDLINE =====
          'errorpercentage1', 'errorpercentage2', 'errorpercentage3', 'errorpercentage4',
          'errorpercentage5', 'errorpercentage6', 'errorpercentage7', 'errorpercentage8',
          'errorpercentage9', 'errorpercentage10', 'errorpercentage11', 'errorpercentage12',
          'errorpercentage13', 'errorpercentage14',
          
          // ===== Target and additional metrics =====
          'target', 'targetNew', 'diffTarget', 'rftTarget',
          
          // ===== NEW: DỮ LIỆU và NGUYÊN NHÂN (AI, AJ) =====
          'duLieu', 'nguyenNhan'
        ];
        
        const slotChecksum = fields.map(f => {
          const value = slotData[f];
          return value !== undefined && value !== null ? String(value) : '0';
        }).join(',');
        
        checksumParts.push(`${slot}:${slotChecksum}`);
      }
    });

    return checksumParts.join('|');
  }

  private isInActiveProductionBlock(date: Date): boolean {
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    const activeBlocks = [
      "08:30", "09:30", "10:30", "11:30", "13:30", "14:30", 
      "15:30", "16:30", "18:00", "19:00", "20:00",

      //  Additional for testing outside work hours
      "9:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00",
      "17:00", "18:30", "19:30", "20:30"
    ];

    return activeBlocks.some((block) => {
      const [h, m] = block.split(":").map(Number);
      const start = h * 60 + m;
      const end = start + 30;
      return nowMinutes >= start && nowMinutes < end;
    });
  }

  stopRealtimeMonitoring() {
    this.isListening = false;
    this.previousData.clear();
  }

  getMonitoringStats() {
    return {
      lineType: 'HTM',
      isListening: this.isListening,
      trackedRecords: this.previousData.size,
      lastCheck: new Date().toISOString()
    };
  }
  
  // Manual trigger for testing (bypasses time restrictions)
  async manualCheckForChanges() {
    this.logger.log('🔧 HTM Sheets: Manual check triggered');
    
    if (!this.isListening) {
      this.logger.warn('⚠️ HTM Sheets: Listener not active');
      return;
    }
    
    // Reset lastCheckTime to bypass throttle
    this.lastCheckTime = 0;
    
    // Call internal check logic directly (bypass cron restrictions)
    await this.performCheck();
  }
  
  // Internal check logic (can be called by cron or manual trigger)
  private async performCheck() {
    try {
      // ⚡ OPTIMIZATION: Only check lines that we're tracking (on-demand)
      if (this.previousData.size === 0) {
        this.logger.debug('🔍 HTM Sheets: No tracked lines, skipping check');
        return;
      }

      this.logger.log(`🔍 HTM Sheets: Checking ${this.previousData.size} tracked lines...`);

      const changes: Array<{ key: string; type: 'updated' | 'new'; data: any }> = [];

      // 🚀 BATCH PROCESSING: Add delay between line checks to prevent quota bursts
      const DELAY_BETWEEN_LINES = 500; // 500ms delay between each line check
      let processedCount = 0;

      // Only check lines we're already tracking
      for (const [key, previousRecord] of this.previousData.entries()) {
        try {
          const [maChuyenLine, indexStr] = key.split('_');
          const index = parseInt(indexStr);
          const factory = this.extractFactoryFromMaChuyenLine(maChuyenLine);
          
          if (!factory) {
            this.logger.warn(`⚠️ HTM Sheets: Cannot extract factory from ${maChuyenLine}`);
            continue;
          }

          this.logger.debug(`🔍 HTM Sheets: Checking ${key} (${processedCount + 1}/${this.previousData.size}) - factory: ${factory}, index: ${index}`);

          // ✅ OPTIMIZED: Only fetch merged data (ENDLINE data already included)
          // This reduces API calls from 5 reads to 3 reads per line (40% reduction)
          const mergedData = await this.htmSheetsService.getProductionDataWithEndlineMerge(
            maChuyenLine,
            factory,
            index,
            true // bypassCache=true
          );

          // 🚀 Add delay after each line to prevent quota bursts (except last line)
          processedCount++;
          if (processedCount < this.previousData.size) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_LINES));
          }

          if (!mergedData) {
            this.logger.warn(`⚠️ HTM Sheets: No data returned for ${key}`);
            // Don't add delay for failed requests to speed up processing
            continue;
          }

          const currentChecksum = this.calculateChecksum(mergedData);
          
          // this.logger.log(`🔍 HTM Sheets: Checksum comparison for ${key}:`);
          // this.logger.log(`   Previous: ${previousRecord.checksum.substring(0, 30)}...`);
          // this.logger.log(`   Current:  ${currentChecksum.substring(0, 30)}...`);
          // this.logger.log(`   Match: ${previousRecord.checksum === currentChecksum}`);

          if (previousRecord.checksum !== currentChecksum) {
            // Data changed - Log specific field changes from BOTH sheets
            const prev = previousRecord.data;
            const curr = mergedData;
            const changedFields: string[] = [];
            
            // 🚀 Check ALL fields from DATA BCSL HTM + ENDLINE
            const allFields = [
              // DATA BCSL HTM fields
              'maChuyenLine', 'nhaMay', 'line', 'to', 'maHang', 'slth', 'congKh', 'congTh', 
              'lkth', 'phanTramHt', 'pphKh', 'pphTh', 'ldLayout', 'ldCoMat', 'targetNgay', 
              'targetGio', 'lkkh', 'gioSx', 'thoigianlamviec', 'nangSuat',
              // ENDLINE fields
              'tongKiem', 'tongDat', 'tongLoi', 'datLan1', 'rft', 'diffRftTarget',
              'loi1', 'loi2', 'loi3', 'loi4', 'loi5', 'loi6', 'loi7',
              'loi8', 'loi9', 'loi10', 'loi11', 'loi12', 'loi13', 'loi14',
              'tuiChuaTaiChe'
            ];
            
            allFields.forEach(field => {
              if (prev[field] !== curr[field]) {
                changedFields.push(`${field}: "${prev[field]}" → "${curr[field]}"`);
              }
            });
            
            // Check sheet switching (ENDLINE_BEFORE → ENDLINE_DAILY at 8:30 AM)
            if (prev._debug?.endlineSheetSource !== curr._debug?.endlineSheetSource) {
              changedFields.push(`_endlineSheet: "${prev._debug?.endlineSheetSource}" → "${curr._debug?.endlineSheetSource}"`);
            }
            
            // 🚀 Check hourly data changes from BOTH sheets
            const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
            const hourlyChanges: string[] = [];
            
            timeSlots.forEach(slot => {
              const prevSlot = prev.hourlyData?.[slot];
              const currSlot = curr.hourlyData?.[slot];
              
              if (prevSlot && currSlot) {
                // Check ALL hourly fields from both DATA BCSL HTM + ENDLINE
                const hourlyFields = [
                  'sanluong', 'percentage', 'sanluongNew', 'percentageNew',
                  'tongKiem', 'tongKiemNew', 'tongDat', 'tongLoi', 'datLan1', 'rft',
                  'tuiChuaTaiChe', 'tuiChuaTaiCheNew',
                  'loi1', 'loi2', 'loi3', 'loi4', 'loi5', 'loi6', 'loi7',
                  'loi8', 'loi9', 'loi10', 'loi11', 'loi12', 'loi13', 'loi14'
                ];
                
                hourlyFields.forEach(field => {
                  if (prevSlot[field] !== currSlot[field]) {
                    hourlyChanges.push(`${slot}.${field}: ${prevSlot[field]} → ${currSlot[field]}`);
                  }
                });
              }
            });
            
            if (changedFields.length > 0) {
              this.logger.log(`📝 HTM Sheets: Changed fields (DATA BCSL + ENDLINE): ${changedFields.slice(0, 5).join(', ')}${changedFields.length > 5 ? ` (+${changedFields.length - 5} more)` : ''}`);
            }
            
            if (hourlyChanges.length > 0) {
              this.logger.log(`📝 HTM Sheets: Changed hourly fields (DATA BCSL + ENDLINE): ${hourlyChanges.slice(0, 3).join(', ')}${hourlyChanges.length > 3 ? ` (+${hourlyChanges.length - 3} more)` : ''}`);
            }
            
            if (changedFields.length === 0 && hourlyChanges.length === 0) {
              this.logger.warn(`⚠️ HTM Sheets: Checksum changed but no field differences detected for ${key}`);
            }
            
            changes.push({
              key,
              type: 'updated',
              data: mergedData
            });
            this.previousData.set(key, { data: mergedData, checksum: currentChecksum });
          } else {
            this.logger.log(`✅ HTM Sheets: No change detected in ${key} (checksums match)`);
          }
        } catch (error) {
          this.logger.warn(`⚠️ HTM Sheets: Error checking ${key}:`, error.message);
        }
      }

      if (changes.length > 0) {
        this.logger.log(`🔔 HTM Sheets: Found ${changes.length} changes`);
        
        for (const change of changes) {
          this.emitChange(change);
        }
        
        this.websocketGateway.broadcastSystemUpdate('htm-sheets-refresh', {
          changesCount: changes.length,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      this.logger.error('❌ HTM Sheets: Error checking for changes:', error);
    }
  }
  
  // Public method to trigger on-demand loading when client subscribes
  async handleClientSubscription(maChuyenLine: string, factory: string, index?: number): Promise<void> {
    // Extract index from query if not provided
    if (index === undefined || index === null) {
      // Try to extract from factory/line mapping
      this.logger.warn(`⚠️ HTM Sheets: No index provided for ${maChuyenLine}, skipping on-demand load`);
      return;
    }
    
    this.logger.log(`📡 HTM Sheets: Client subscribed to ${maChuyenLine}, loading data...`);
    await this.loadLineData(maChuyenLine, factory, index);
  }
}
