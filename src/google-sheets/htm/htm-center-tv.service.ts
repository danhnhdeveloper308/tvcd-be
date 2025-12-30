import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

/**
 * HTM Center TV Service - For central TV display
 * Reads DATA sheet and returns 3 groups (Quai-Sơn-Lót) per line
 */
@Injectable()
export class HTMCenterTVService {
  private readonly logger = new Logger(HTMCenterTVService.name);
  private sheets: any;
  
  // In-memory cache
  private dataCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 30000; // 30 seconds cache
  
  // Request throttling
  private requestQueue: Promise<any> = Promise.resolve();
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 100; // Minimum 100ms between requests
  
  constructor(private configService: ConfigService) {
    this.initializeGoogleSheets();
  }
  
  // ⭐ OPTIMIZATION: Throttle requests to avoid quota spikes
  private async throttleRequest(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      const delay = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    this.lastRequestTime = Date.now();
  }

  private async initializeGoogleSheets() {
    try {
      const serviceAccountKey = this.configService.get<string>('GOOGLE_SERVICE_ACCOUNT_KEY');
      
      if (!serviceAccountKey) {
        this.logger.error('GOOGLE_SERVICE_ACCOUNT_KEY is not configured');
        throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is required');
      }

      let credentials;
      try {
        credentials = JSON.parse(serviceAccountKey || '{}');
        
        if (!credentials.type || credentials.type !== 'service_account') {
          throw new Error('Invalid service account credentials');
        }
        
      } catch (parseError) {
        this.logger.error('❌ Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY JSON:', parseError);
        this.sheets = null;
        return;
      }

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.sheets = google.sheets({ version: 'v4', auth });
      
    } catch (error) {
      this.logger.error('Failed to initialize Google Sheets API for HTM Center TV:', error);
      this.sheets = null;
    }
  }

  async getSheetData(sheetName: string, range?: string): Promise<any[][]> {
    const maxRetries = 3;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Throttle request to avoid quota spikes
        await this.throttleRequest();
        
        const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID');
        
        // Use default range from ENV if not provided
        if (!range) {
          range = this.configService.get<string>('HTM_CENTER_TV_RANGE') || 'A1:AA38';
        }

        const response = await this.sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!${range}`,
        });

        return response.data.values || [];
      } catch (error) {
        const isLastAttempt = attempt === maxRetries - 1;
        
        // Check if it's a quota error
        if (error.message && error.message.includes('Quota exceeded')) {
          if (!isLastAttempt) {
            // Exponential backoff with jitter: 1s, 2s, 4s
            const baseDelay = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * 500;
            const delay = baseDelay + jitter;
            
            this.logger.warn(`⏳ HTM Center TV: Quota exceeded for ${sheetName}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        // If last attempt or non-quota error, log and return empty
        this.logger.error(`❌ HTM Center TV: Failed to fetch data from sheet ${sheetName} after ${attempt + 1} attempts:`, error.message);
        return [];
      }
    }
    
    return [];
  }

  /**
   * Get center TV data filtered by factory and line
   * Returns 3 groups (Quai-Sơn-Lót) per line
   */
  async getCenterTVData(factory: string, line: string): Promise<any> {
    try {
      const cacheKey = `center_tv_${factory}_${line}`;
      const cached = this.dataCache.get(cacheKey);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
        return cached.data;
      }
      
      const values = await this.getSheetData('DATA_QSL', 'A1:AA38');
      
      if (values.length <= 1) {
        this.logger.warn(`No data found in DATA sheet`);
        return { factory, line, groups: [] };
      }

      const headers = values[0];
      const data = values.slice(1);
      
      // Filter by factory and line, get 3 groups (Quai-Sơn-Lót)
      const lineData = data
        .filter(row => {
          const nhaMay = (row[0] || '').toString().trim(); // Column A: NM
          const lineValue = (row[1] || '').toString().trim(); // Column B: LINE
          
          // Match factory
          const factoryMatch = nhaMay.toUpperCase() === factory.toUpperCase();
          
          // Match line - support both "LINE 1" and "1" formats
          const lineMatch = lineValue === line.toString() || 
                           lineValue === `LINE ${line}` ||
                           lineValue.replace(/LINE\s*/i, '').trim() === line.toString();
          
          // if (factoryMatch && lineMatch) {
          //   this.logger.debug(`✅ Match found: NM="${nhaMay}", LINE="${lineValue}", NHOM="${row[2]}"`);
          // }
          
          return factoryMatch && lineMatch;
        })
        .map((row, index) => this.parseRowData(row, index));

      const result = {
        factory,
        line,
        groups: lineData, // Should return 3 groups: Quai, Sơn, Lót
        timestamp: new Date().toISOString()
      };
      
      this.dataCache.set(cacheKey, { data: result, timestamp: Date.now() });

      return result;
    } catch (error) {
      this.logger.error(`Failed to get center TV data for ${factory} LINE ${line}:`, error);
      return { factory, line, groups: [] };
    }
  }

  private parseRowData(row: any[], index: number): any {
    return {
      id: index,
      nhaMay: row[0] || '',              // A: NM
      line: row[1] || '',                 // B: LINE
      nhom: row[2] || '',                 // C: NHÓM (Quai/Sơn/Lót)
      layout: this.parseNumber(row[3]),   // D: LAYOUT
      tglv: this.parseNumber(row[4]),     // E: TGLV (Thời gian làm việc)
      keHoachGio: this.parseNumber(row[5]),  // F: KẾ HOẠCH GIỜ
      keHoachNgay: this.parseNumber(row[6]), // G: KẾ HOẠCH NGÀY
      
      // Hourly data (H-R: columns 7-17)
      h830: this.parseNumber(row[7]),     // H: 8H30
      h930: this.parseNumber(row[8]),     // I: 9H30
      h1030: this.parseNumber(row[9]),    // J: 10H30
      h1130: this.parseNumber(row[10]),   // K: 11H30
      h1330: this.parseNumber(row[11]),   // L: 13H30
      h1430: this.parseNumber(row[12]),   // M: 14H30
      h1530: this.parseNumber(row[13]),   // N: 15H30
      h1630: this.parseNumber(row[14]),   // O: 16H30
      h1800: this.parseNumber(row[15]),   // P: 18H
      h1900: this.parseNumber(row[16]),   // Q: 19H
      h2000: this.parseNumber(row[17]),   // R: 20H
      
      soLuongGiaoMay: this.parseNumber(row[18]), // S: SỐ LƯỢNG GIAO MAY
      lkKh: this.parseNumber(row[19]),           // T: LUỸ KẾ KẾ HOẠCH
      lkTh: this.parseNumber(row[20]),           // U: LUỸ KẾ THỰC HIỆN
      phanTramHt: this.parsePercentage(row[21]), // V: %HT
      lean: row[22] || '',                       // W: LEAN
      bqTargetGio: this.parseNumber(row[23]),    // X: BQ TARGET GIỜ
      sthd: this.parseNumber(row[24]),           // Y: STHĐ
      slcl: this.parseNumber(row[25]),           // Z: SLCL
      tienDoApUng: this.parsePercentage(row[26]), // AA: TIẾN ĐỘ ĐÁP ỨNG
      
      // Calculate additional fields
      diffLkThKh: this.parseNumber(row[20]) - this.parseNumber(row[19]), // lkTh - lkKh
      diffPhanTramHt100: this.parsePercentage(row[21]) - 100, // %HT - 100%
    };
  }

  private parseNumber(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  private parsePercentage(value: any): number {
    if (typeof value === 'number') {
      return value;
    }
    
    if (typeof value === 'string') {
      let cleaned = value.toString();
      cleaned = cleaned.replace(',', '.');
      cleaned = cleaned.replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(cleaned);
      if (isNaN(parsed)) return 0;
      return parsed;
    }
    
    return 0;
  }
}