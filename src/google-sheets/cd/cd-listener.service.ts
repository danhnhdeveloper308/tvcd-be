import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { WebsocketGateway } from '../../websocket/websocket.gateway';
import { CDSheetsService } from './cd-sheets.service';

@Injectable()
export class CDListenerService {
  private readonly logger = new Logger(CDListenerService.name);
  private previousData: Map<string, any> = new Map();
  private isListening = false;
  private lastCheckTime: number = 0;

  constructor(
    private configService: ConfigService,
    private websocketGateway: WebsocketGateway,
    private cdSheetsService: CDSheetsService,
  ) {}

  async onModuleInit() {
    await this.startRealtimeMonitoring();
  }

  async startRealtimeMonitoring() {
    if (this.isListening) {
      this.logger.warn('CD real-time monitoring already started');
      return;
    }

    this.isListening = true;

    await this.loadInitialData();
    
  }

  private async loadInitialData() {
    try {
      // ✅ Use SERVER_FACTORY from env instead of hardcoded 'ALL'
      const serverFactory = this.configService.get<string>('SERVER_FACTORY') || 'ALL';
      this.logger.log(`📦 CD: Loading initial data for factory=${serverFactory}`);
      
      const data = await this.cdSheetsService.getProductionData(serverFactory);
      
      data.forEach(record => {
        if (record.maChuyenLine) {
          this.previousData.set(record.maChuyenLine, {
            data: record,
            checksum: this.calculateChecksum(record)
          });
        }
      });

      this.logger.log(`✅ CD: Loaded ${this.previousData.size} lines for factory=${serverFactory}`);
    } catch (error) {
      this.logger.error('Failed to load initial CD data:', error);
    }
  }

  // 🚀 CONFIGURABLE: Cron schedule via env variable to stagger checks across servers
  // TS1 (.env.ts1): CD_CRON_SCHEDULE="0-58/2 * * * 1-6" (even minutes: 00, 02, 04...)
  // TS2 (.env.ts2): CD_CRON_SCHEDULE="1-59/2 * * * 1-6" (odd minutes: 01, 03, 05...)
  // TS3 (.env.ts3): CD_CRON_SCHEDULE="*/3 * * * 1-6" (every 3 min: 00, 03, 06...)
  // Default: Every 2 minutes all day (Mon-Sat)
  @Cron(process.env.CD_CRON_SCHEDULE || '*/2 * * * 1-6', {
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async checkForChanges() {
    if (!this.isListening) {
      return;
    }

    const vietnamTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const timeStr = vietnamTime.toLocaleTimeString('vi-VN');
    
    // Prevent too frequent checks
    const now = Date.now();
    if (this.lastCheckTime && (now - this.lastCheckTime) < 90000) { // Min 90 seconds between checks
      this.logger.debug(`⏭️ CD Sheets: Skipping check (last check was ${Math.floor((now - this.lastCheckTime) / 1000)}s ago)`);
      return;
    }
    this.lastCheckTime = now;
    
    this.logger.log(`⏰ CD Sheets: Cron triggered at ${timeStr} (2-minute staggered interval)`);
    
    try {
      // ✅ Use SERVER_FACTORY from env instead of hardcoded 'ALL'
      const serverFactory = this.configService.get<string>('SERVER_FACTORY') || 'ALL';
      
      const currentData = await this.cdSheetsService.getProductionData(serverFactory);
      
      if (!currentData || currentData.length === 0) {
        this.logger.debug(`🔍 CD Sheets: No CD production data found for ${serverFactory}`);
        return;
      }

      this.logger.log(`🔍 CD Sheets: Checking ${currentData.length} CD lines...`);
      
      const changes: Array<{ maChuyenLine: string; type: 'updated' | 'new' | 'deleted'; data: any }> = [];
      
      // 🚀 BATCH PROCESSING: Add delay between line checks
      const DELAY_BETWEEN_LINES = 500; // 500ms delay
      let processedCount = 0;

      for (const record of currentData) {
        if (!record.maChuyenLine) continue;

        processedCount++;
        this.logger.debug(`🔍 CD Sheets: Checking ${record.maChuyenLine} (${processedCount}/${currentData.length})`);

        const previousRecord = this.previousData.get(record.maChuyenLine);
        const currentChecksum = this.calculateChecksum(record);

        if (!previousRecord) {
          changes.push({ maChuyenLine: record.maChuyenLine, type: 'new', data: record });
          this.previousData.set(record.maChuyenLine, { data: record, checksum: currentChecksum });
        } else if (previousRecord.checksum !== currentChecksum) {
          changes.push({ maChuyenLine: record.maChuyenLine, type: 'updated', data: record });
          this.previousData.set(record.maChuyenLine, { data: record, checksum: currentChecksum });
        }
        
        // 🚀 Add delay after each line (except last)
        if (processedCount < currentData.length) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_LINES));
        }
      }

      const currentMaChuyenLines = new Set(currentData.map(r => r.maChuyenLine).filter(Boolean));
      for (const [maChuyenLine, previousRecord] of this.previousData.entries()) {
        if (!currentMaChuyenLines.has(maChuyenLine)) {
          changes.push({ maChuyenLine, type: 'deleted', data: previousRecord.data });
          this.previousData.delete(maChuyenLine);
        }
      }

      if (changes.length > 0) {
        
        for (const change of changes) {
          await this.emitChange(change);
        }
        
        this.websocketGateway.broadcastSystemUpdate('cd-data-refresh', {
          changesCount: changes.length,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      this.logger.error('❌ CD: Error checking for changes:', error);
    }
  }

  private async emitChange(change: { maChuyenLine: string; type: string; data: any }) {
    const { maChuyenLine, type, data } = change;
    
    // ✅ CRITICAL: Emit to CD-specific channel using emitMaChuyenLineUpdate
    this.websocketGateway.emitMaChuyenLineUpdate(maChuyenLine, {
      maChuyenLine,
      lineType: 'CD',
      data: {
        type,
        data: data,
        summary: this.calculateSummaryFromRecord(data),
      },
      timestamp: new Date().toISOString()
    });
    
    // ✅ Also emit to factory channel
    if (data.nhaMay) {
      this.websocketGateway.emitProductionUpdate(data.nhaMay, {
        type,
        maChuyenLine,
        lineType: 'CD',
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
    // CD-specific summary with A-BB fields (updated mapping)
    return {
      maChuyenLine: record.maChuyenLine || '',
      nhaMay: record.nhaMay || '',
      line: record.line || '',
      canBoQuanLy: record.canBoQuanLy || '', // ⭐ Add canBoQuanLy
      to: record.to || '',
      maHang: record.maHang || '',
      
      // Production metrics (F-W)
      slth: record.slth || 0,
      congKh: record.congKh || 0,
      congTh: record.congTh || 0,
      pphKh: record.pphKh || 0,
      pphTh: record.pphTh || 0,
      phanTramHtPph: record.phanTramHtPph || 0,
      gioSx: record.gioSx || 0,
      ldCoMat: record.ldCoMat || 0,
      ldLayout: record.ldLayout || 0,
      ldHienCo: record.ldHienCo || 0,
      nangSuat: record.nangSuat || 0,
      pphTarget: record.pphTarget || 0,
      pphGiao: record.pphGiao || 0,
      phanTramGiao: record.phanTramGiao || 0,
      targetNgay: record.targetNgay || 0,
      targetGio: record.targetGio || 0,
      lkth: record.lkth || 0,
      phanTramHt: record.phanTramHt || 0,
      
      // Hourly data (X-AH: index 23-33)
      hourlyData: record.hourlyData || {},
      
      // CD fields (AI-AS: index 34-44)
      lean: record.lean || '',
      phanTram100: record.phanTram100 || 0,
      image: record.image || '',
      lkkh: record.lkkh || 0,
      khGiaoThang: record.khGiaoThang || 0,
      khbqGQ: record.khbqGQ || 0,
      slkh_bqlk: record.slkh_bqlk || 0,
      slthThang: record.slthThang || 0,
      phanTramThang: record.phanTramThang || 0,
      conlai: record.conlai || 0,
      bqCansxNgay: record.bqCansxNgay || 0,
      
      // AT-BB fields (index 45-53)
      tglv: record.tglv || 0,
      ncdv: record.ncdv || 0,
      dbcu: record.dbcu || 0,
      phanTramDapUng: record.phanTramDapUng || 0,
      tonMay: record.tonMay || 0,
      nc1ntt: record.nc1ntt || 0,
      nc2ntt: record.nc2ntt || 0,
      nc3ntt: record.nc3ntt || 0,
      note: record.note || '',
      db1ntt: record.db1ntt || 0,
      db2ntt: record.db2ntt || 0,
      db3ntt: record.db3ntt || 0,
      dbNgay: record.dbNgay || 0,

      // Sub-rows data with full fields
      subRows: record.subRows || [],
      ncdvTotal: record.ncdvTotal || record.ncdv || 0,
      dbcuTotal: record.dbcuTotal || record.dbcu || 0,
      tonMayTotal: record.tonMayTotal || record.tonMay || 0,
      nc1nttTotal: record.nc1nttTotal || record.nc1ntt || 0,
      nc2nttTotal: record.nc2nttTotal || record.nc2ntt || 0,
      nc3nttTotal: record.nc3nttTotal || record.nc3ntt || 0,
      db1nttTotal: record.db1nttTotal || record.db1ntt || 0,
      db2nttTotal: record.db2nttTotal || record.db2ntt || 0,
      db3nttTotal: record.db3nttTotal || record.db3ntt || 0,
      dbNgayTotal: record.dbNgayTotal || record.dbNgay || 0,

      // Grouping metadata
      groupingRule: record.groupingRule || null,
      
      // Calculated diff field
      diffLdCoMatLayout: record.diffLdCoMatLayout || 0,
      
      _lastSocketUpdate: Date.now(),
    };
  }

  private calculateChecksum(record: any): string {
    // CD-specific fields for change detection (A-BB structure)
    const fields = [
      // Basic info (A-E)
      'maChuyenLine', 'nhaMay', 'line', 'canBoQuanLy', 'to', 'maHang', // ⭐ Add canBoQuanLy
      // Production (F-W)
      'slth', 'congKh', 'congTh', 'pphKh', 'pphTh', 'phanTramHtPph', 'gioSx',
      'ldCoMat', 'ldLayout', 'ldHienCo', 'nangSuat',
      'pphTarget', 'pphGiao', 'phanTramGiao', 'targetNgay', 'targetGio', 'lkth', 'phanTramHt',
      // CD fields (AI-AS: index 34-44)
      'lean', 'phanTram100', 'image', 'lkkh',
      'khGiaoThang', 'khbqGQ', 'slkh_bqlk', 'slthThang', 'phanTramThang', 
      'conlai', 'bqCansxNgay',
      // AT-BB fields (index 45-53)
      'tglv', 'ncdv', 'dbcu', 'phanTramDapUng', 'tonMay', 
      'nc1ntt', 'nc2ntt', 'nc3ntt', 'note',
      'db1ntt', 'db2ntt', 'db3ntt', 'dbNgay',
      // Totals from subRows
      'ncdvTotal', 'dbcuTotal', 'tonMayTotal', 'nc1nttTotal', 'nc2nttTotal', 'nc3nttTotal', 'db1nttTotal', 'db2nttTotal', 'db3nttTotal', 'dbNgayTotal',
    ];
    
    const fieldValues = fields.map(field => String(record[field] || '')).join('|');
    
    // Add hourly data to checksum
    const hourlyValues = this.serializeHourlyData(record.hourlyData || {});
    
    // Add sub-rows data to checksum (now includes all fields)
    const subRowsValues = this.serializeSubRows(record.subRows || []);
    
    const checksumString = fieldValues + '|' + hourlyValues + '|' + subRowsValues;
    
    // Log checksum for debugging
    // this.logger.debug(`CD Checksum for ${record.maChuyenLine}: ${checksumString.substring(0, 100)}...`);
    
    return Buffer.from(checksumString).toString('base64');
  }

  private serializeSubRows(subRows: any[]): string {
    if (!Array.isArray(subRows) || subRows.length === 0) {
      return '';
    }
    
    // Include all sub-row fields for checksum
    return subRows.map(sr => 
      `${sr.tglv || 0},${sr.maHang || ''},${sr.targetNgay || 0},${sr.targetGio || 0},${sr.lkkh || 0},${sr.lkth || 0},${sr.ncdv || 0},${sr.dbcu || 0},${sr.tonMay || 0},${sr.nc1ntt || 0},${sr.nc2ntt || 0},${sr.nc3ntt || 0},${sr.note || ''}`
    ).join('|');
  }

  private serializeHourlyData(hourlyData: any): string {
    if (!hourlyData || typeof hourlyData !== 'object') {
      return '';
    }

    // Handle both nested and flat structures
    const hourlySlots = hourlyData.hourly || hourlyData;
    
    const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
    const checksumParts: string[] = [];

    timeSlots.forEach(slot => {
      const slotData = hourlySlots[slot];
      if (slotData && typeof slotData === 'object') {
        const slotChecksum = `${slotData.sanluong || 0},${slotData.percentage || 0}`;
        checksumParts.push(`${slot}:${slotChecksum}`);
      }
    });

    return checksumParts.join('|');
  }

  private isInActiveProductionBlock(date: Date): boolean {
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    const activeBlocks = [
      "08:30", "09:30", "10:30", "11:30", "13:30", "14:30", 
      "15:30", "16:30", "18:00", "19:00", "20:00"
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
      lineType: 'CD',
      isListening: this.isListening,
      trackedRecords: this.previousData.size,
      lastCheck: new Date().toISOString()
    };
  }
}
