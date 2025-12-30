import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

/**
 * HTM-specific Google Sheets Service
 * Handles data from HTM production lines (existing logic)
 */
@Injectable()
export class HTMSheetsService {
  private readonly logger = new Logger(HTMSheetsService.name);
  private sheets: any;
  
  // In-memory cache to reduce API calls
  private dataCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 0; // ⚠️ DISABLED CACHE for TV real-time updates
  
  // Quota management
  private isQuotaExceeded = false;
  private quotaResetTime = 0;
  // private requestCount = 0;
  // private requestWindowStart = Date.now();

  constructor(private configService: ConfigService) {
    this.initializeGoogleSheets();
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
      
      await this.testConnection();
      
    } catch (error) {
      this.logger.error('Failed to initialize Google Sheets API for HTM:', error);
      this.sheets = null;
    }
  }

  private async testConnection() {
    try {
      const sheetId = this.configService.get<string>('GOOGLE_SHEET_ID');
      if (sheetId && this.sheets) {
        await this.sheets.spreadsheets.get({
          spreadsheetId: sheetId,
          fields: 'properties.title'
        });
      }
    } catch (error) {
      this.logger.warn('Google Sheets connection test failed for HTM:', error.message);
    }
  }

  /**
   * ✅ Throttle API requests to avoid burst calls
   * Ensures minimum interval between consecutive requests
   */
  private async throttleRequest(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      const delay = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    this.lastRequestTime = Date.now();
  }

  // Request queue for throttling
  private requestQueue: Array<() => Promise<any>> = [];
  private isProcessingQueue = false;
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 100; // 100ms between requests

  async getSheetData(sheetName: string, range?: string): Promise<any[][]> {
    try {
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID');
      
      // Use default range from ENV if not provided
      if (!range) {
        range = 'A1:C040';
      }

      // ✅ Retry with exponential backoff on quota errors
      const maxRetries = 3;
      let lastError: any;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // ✅ Throttle requests to avoid burst
          await this.throttleRequest();

          const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!${range}`,
          });

          return response.data.values || [];
        } catch (error) {
          lastError = error;
          
          // Check if quota error
          if (error.message?.includes('Quota exceeded')) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500; // 1s, 2s, 4s + jitter
            this.logger.warn(`⏳ HTM: Quota exceeded for ${sheetName}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
            
            if (attempt < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }
          
          throw error;
        }
      }

      throw lastError;
    } catch (error) {
      this.logger.error(`❌ HTM: Failed to fetch data from sheet ${sheetName}:`, error);
      return [];
    }
  }

  async getProductionLinesList(): Promise<Array<{code: string; nhaMay: string; line: string; to: string; percentagePPH: string; percentageHT: string; rft: string}>> {
    try {
      // Get range from ENV or use default
      const linesRange = this.configService.get<string>('HTM_LINES_RANGE') || 'A1:CO40';
      const values = await this.getSheetData('DATA BCSL HTM', linesRange);

      if (values.length <= 1) {
        this.logger.warn(`HTM: No data found in sheet`);
        return [];
      }

      const data = values.slice(1);
      const linesSet = new Set<string>();

      const linesList = data
        .map((row) => {
          const code = (row[0] || '').toString().trim();
          const nhaMay = (row[1] || '').toString().trim();
          const line = (row[2] || '').toString().trim();
          const to = (row[3] || '').toString().trim();
          const percentagePPH = row[10];
          const percentageHT = row[22];
          const rft = row[53];

          if (code === '' || 
              !code.startsWith('KVHB') && !code.startsWith('KV') ||
              code === 'LKKH' || 
              code.includes('MÃ CHUYỀN')) {
            return null;
          }

          const uniqueKey = `${code}`;
          if (!linesSet.has(uniqueKey)) {
            linesSet.add(uniqueKey);
            return { code, nhaMay, line, to, percentagePPH, percentageHT, rft };
          }
          return null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => a.code.localeCompare(b.code));

      return linesList;

    } catch (error) {
      this.logger.error(`❌ HTM: Error fetching production lines list:`, error);
      return [
        { code: 'KVHB07M01', nhaMay: 'TS1', line: 'LINE 1', to: 'TỔ 1', percentagePPH: '', percentageHT: '', rft: '' },
      ];
    }
  }

  /**
   * Get raw ENDLINE data by row index (for direct row access)
   * @param factory - Factory name (TS1, TS2, TS3, ALL)
   * @param rowIndex - Row index on ENDLINE sheet (0-based, excluding header)
   */
  async getEndlineDataByRowIndex(factory: string, rowIndex: number): Promise<any | null> {
    try {
      const serverFactory = factory.toUpperCase();
      const { sheetName: rftSheetName, range: rftRange } = this.getEndlineSheetConfig(serverFactory);
      
      // this.logger.log(`📊 HTM: Fetching ENDLINE data for factory=${factory}, row index=${rowIndex}, sheet=${rftSheetName}, range=${rftRange}`);
      
      const fetchStart = Date.now();
      const rftValues = await this.getSheetData(rftSheetName, rftRange);
      const fetchTime = Date.now() - fetchStart;
      
      // this.logger.log(`✅ HTM: Fetched ENDLINE sheet in ${fetchTime}ms - rows: ${rftValues?.length || 0}`);
      
      if (!rftValues || rftValues.length <= 1) {
        this.logger.warn('HTM: No ENDLINE data available');
        return null;
      }
      
      // Skip header row
      const dataRows = rftValues.slice(1);
      
      // Track NM and LINE for fill-forward
      let currentNhaMay = '';
      let currentLine = '';
      
      // Find the target row
      if (rowIndex < 0 || rowIndex >= dataRows.length) {
        this.logger.warn(`⚠️ HTM: Row index ${rowIndex} out of bounds (0-${dataRows.length - 1})`);
        return null;
      }
      
      // Need to iterate to fill-forward NM and LINE
      for (let i = 0; i <= rowIndex; i++) {
        const row = dataRows[i];
        const rowNM = (row[0] || '').toString().trim();
        const rowLINE = (row[1] || '').toString().trim();
        if (rowNM) currentNhaMay = rowNM;
        if (rowLINE) currentLine = rowLINE;
      }
      
      const targetRow = dataRows[rowIndex];
      
      // Parse the row data
      let nhaMay = (targetRow[0] || '').toString().trim();
      let line = (targetRow[1] || '').toString().trim();
      const to = (targetRow[4] || '').toString().trim();
      
      // Apply fill-forward
      if (!nhaMay) nhaMay = currentNhaMay;
      if (!line) line = currentLine;
      
      // this.logger.log(`📍 HTM: ENDLINE row ${rowIndex}: NM="${nhaMay}", LINE="${line}", TO="${to}"`);
      
      const tongKiem = this.parseNumber(targetRow[5]) || 0;
      const datLan1 = this.parseNumber(targetRow[6]) || 0;
      const tongDat = this.parseNumber(targetRow[7]) || 0;
      const rft = this.parsePercentage(targetRow[22]) || 0;
      
      // Parse error columns
      const loi1 = this.parseNumber(targetRow[8]) || 0;
      const loi2 = this.parseNumber(targetRow[9]) || 0;
      const loi3 = this.parseNumber(targetRow[10]) || 0;
      const loi4 = this.parseNumber(targetRow[11]) || 0;
      const loi5 = this.parseNumber(targetRow[12]) || 0;
      const loi6 = this.parseNumber(targetRow[13]) || 0;
      const loi7 = this.parseNumber(targetRow[14]) || 0;
      const loi8 = this.parseNumber(targetRow[15]) || 0;
      const loi9 = this.parseNumber(targetRow[16]) || 0;
      const loi10 = this.parseNumber(targetRow[17]) || 0;
      const loi11 = this.parseNumber(targetRow[18]) || 0;
      const loi12 = this.parseNumber(targetRow[19]) || 0;
      const loi13 = this.parseNumber(targetRow[20]) || 0;
      const loi14 = this.parseNumber(targetRow[21]) || 0;
      
      // Parse columns AI and AJ (indices 34 and 35)
      const duLieu = (targetRow[34] || '').toString().trim();    // AI: DỮ LIỆU
      const nguyenNhan = (targetRow[35] || '').toString().trim(); // AJ: NGUYÊN NHÂN
      
      // Parse time slots (X-AH, columns 23-33)
      const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
      const hourlyData: any = {};
      
      for (let i = 0; i < timeSlots.length; i++) {
        const timeSlot = timeSlots[i];
        const colIndex = 23 + i;
        const hourlyValue = this.parseNumber(targetRow[colIndex]) || 0;
        
        hourlyData[timeSlot] = {
          sanluong: hourlyValue,
          tongKiem,
          datLan1,
          tongDat,
          rft,
          loi1, loi2, loi3, loi4, loi5, loi6, loi7,
          loi8, loi9, loi10, loi11, loi12, loi13, loi14,
          duLieu,       // ⭐ Thêm duLieu từ cột AI
          nguyenNhan,   // ⭐ Thêm nguyenNhan từ cột AJ
        };
      }
      
      // this.logger.log(`✅ HTM: ENDLINE row ${rowIndex} data: tongKiem=${tongKiem}, datLan1=${datLan1}, tongDat=${tongDat}, rft=${rft}%, duLieu="${duLieu}", nguyenNhan="${nguyenNhan}", sheet=${rftSheetName}`);
      
      return {
        nhaMay,
        line,
        to,
        tongKiem,
        datLan1,
        tongDat,
        rft,
        loi1, loi2, loi3, loi4, loi5, loi6, loi7,
        loi8, loi9, loi10, loi11, loi12, loi13, loi14,
        duLieu,       // ⭐ Thêm vào return object
        nguyenNhan,   // ⭐ Thêm vào return object
        hourlyData,
        rowIndex,
        _endlineSheet: rftSheetName, // ⭐ Track which ENDLINE sheet was used
      };
    } catch (error) {
      this.logger.error(`❌ HTM: Failed to get ENDLINE data for row ${rowIndex}:`, error);
      return null;
    }
  }

  /**
   * Get production data merged with ENDLINE data for a specific row
   * @param code - Production line code (maChuyenLine)
   * @param factory - Factory name (TS1, TS2, TS3, ALL)
   * @param rowIndex - Row index on ENDLINE sheet (0-based, excluding header)
   * @param bypassCache - If true, bypass cache to get fresh data (for change detection)
   */
  async getProductionDataWithEndlineMerge(code: string, factory: string, rowIndex: number, bypassCache: boolean = true): Promise<any | null> {
    try {
      const startTime = Date.now();
      // this.logger.log(`🔄 HTM: Merging DATA BCSL HTM + ENDLINE for code=${code}, factory=${factory}, rowIndex=${rowIndex}, bypassCache=${bypassCache}`);
      
      // 1. Get base production data from DATA BCSL HTM - ⚠️ ALWAYS bypass cache
      // this.logger.log(`📊 HTM: Step 1/2 - Fetching from DATA BCSL HTM sheet...`);
      const productionData = await this.getProductionData(factory, true);
      // this.logger.debug(`📊 HTM: Got ${productionData.length} records from DATA BCSL HTM`);
      
      const baseRecord = productionData.find(r => r.maChuyenLine === code);
      
      if (!baseRecord) {
        this.logger.warn(`⚠️ HTM: Code ${code} not found in DATA BCSL HTM. Available codes: ${productionData.slice(0, 5).map(r => r.maChuyenLine).join(', ')}`);
        return null;
      }
      
      // this.logger.log(`✅ HTM: Step 1/2 Complete - Found base record from DATA BCSL HTM: maChuyenLine=${baseRecord.maChuyenLine}, slth=${baseRecord.slth}, congKh=${baseRecord.congKh}`);
      
      // 2. Get ENDLINE data by row index
      // this.logger.log(`📊 HTM: Step 2/2 - Fetching from ENDLINE sheet (row ${rowIndex})...`);
      const endlineData = await this.getEndlineDataByRowIndex(factory, rowIndex);
      
      if (!endlineData) {
        this.logger.warn(`⚠️ HTM: No ENDLINE data found for row ${rowIndex}`);
        return baseRecord; // Return base data only if ENDLINE not found
      }
      
      // this.logger.debug(`✅ HTM: Found ENDLINE data - tongKiem=${endlineData.tongKiem}, datLan1=${endlineData.datLan1}, rft=${endlineData.rft}`)
      
      // 3. Merge: Start with base record, then override with ENDLINE fields
      const merged = Object.assign({}, baseRecord);
      
      // Add ENDLINE specific fields
      merged.tongKiem = endlineData.tongKiem;
      merged.datLan1 = endlineData.datLan1;
      merged.tongDat = endlineData.tongDat;
      merged.rft = endlineData.rft;
      merged.loi1 = endlineData.loi1;
      merged.loi2 = endlineData.loi2;
      merged.loi3 = endlineData.loi3;
      merged.loi4 = endlineData.loi4;
      merged.loi5 = endlineData.loi5;
      merged.loi6 = endlineData.loi6;
      merged.loi7 = endlineData.loi7;
      merged.loi8 = endlineData.loi8;
      merged.loi9 = endlineData.loi9;
      merged.loi10 = endlineData.loi10;
      merged.loi11 = endlineData.loi11;
      merged.loi12 = endlineData.loi12;
      merged.loi13 = endlineData.loi13;
      merged.loi14 = endlineData.loi14;
      
      // Calculate tongLoi (sum of 14 errors)
      merged.tongLoi = merged.loi1 + merged.loi2 + merged.loi3 + merged.loi4 + 
                       merged.loi5 + merged.loi6 + merged.loi7 + merged.loi8 + 
                       merged.loi9 + merged.loi10 + merged.loi11 + merged.loi12 + 
                       merged.loi13 + merged.loi14;
      
      // Merge hourlyData - preserve sanluong from base, add ENDLINE fields
      if (endlineData.hourlyData && baseRecord.hourlyData) {
        merged.hourlyData = {};
        const timeSlots = Object.keys(baseRecord.hourlyData);
        
        for (const timeSlot of timeSlots) {
          const baseHourly = baseRecord.hourlyData[timeSlot] || {};
          const endlineHourly = endlineData.hourlyData[timeSlot] || {};
          
          // Get tongKiem for error percentage calculation
          const tongKiem = endlineHourly.tongKiem || 0;
          
          // Merge: keep base fields (sanluong, percentage, etc.) and add/override with ENDLINE fields
          const mergedHourly = {
            ...baseHourly,  // Keep all base fields including sanluong
            ...endlineHourly,  // Add ENDLINE fields (tongKiem, datLan1, tongDat, rft, loi1-14)
            // Explicitly preserve sanluong from base if ENDLINE doesn't have it
            sanluong: baseHourly.sanluong !== undefined ? baseHourly.sanluong : endlineHourly.sanluong,
          };
          
          // Calculate errorpercentage1-14 (loiX / tongKiem * 100)
          if (tongKiem > 0) {
            mergedHourly.errorpercentage1 = ((endlineHourly.loi1 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage2 = ((endlineHourly.loi2 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage3 = ((endlineHourly.loi3 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage4 = ((endlineHourly.loi4 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage5 = ((endlineHourly.loi5 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage6 = ((endlineHourly.loi6 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage7 = ((endlineHourly.loi7 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage8 = ((endlineHourly.loi8 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage9 = ((endlineHourly.loi9 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage10 = ((endlineHourly.loi10 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage11 = ((endlineHourly.loi11 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage12 = ((endlineHourly.loi12 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage13 = ((endlineHourly.loi13 || 0) / tongKiem) * 100;
            mergedHourly.errorpercentage14 = ((endlineHourly.loi14 || 0) / tongKiem) * 100;
          } else {
            // If no tongKiem, set all error percentages to 0
            mergedHourly.errorpercentage1 = 0;
            mergedHourly.errorpercentage2 = 0;
            mergedHourly.errorpercentage3 = 0;
            mergedHourly.errorpercentage4 = 0;
            mergedHourly.errorpercentage5 = 0;
            mergedHourly.errorpercentage6 = 0;
            mergedHourly.errorpercentage7 = 0;
            mergedHourly.errorpercentage8 = 0;
            mergedHourly.errorpercentage9 = 0;
            mergedHourly.errorpercentage10 = 0;
            mergedHourly.errorpercentage11 = 0;
            mergedHourly.errorpercentage12 = 0;
            mergedHourly.errorpercentage13 = 0;
            mergedHourly.errorpercentage14 = 0;
          }
          
          merged.hourlyData[timeSlot] = mergedHourly;
        }
      } else if (endlineData.hourlyData) {
        merged.hourlyData = endlineData.hourlyData;
      }
      
      // Add metadata
      merged.rowIndex = endlineData.rowIndex;
      merged.source = 'MERGED';
      merged._debug = {
        dataSheetSource: 'DATA_BCSL_HTM',
        endlineSheetSource: endlineData._endlineSheet || 'UNKNOWN',
        mergedAt: new Date().toISOString(),
        vietnamTime: new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"})
      };
      const mergeTime = Date.now() - startTime;
      // this.logger.log(`✅ HTM: Merge Complete (${mergeTime}ms) - slth=${merged.slth}, tongKiem=${merged.tongKiem}, tongLoi=${merged.tongLoi}, rft=${merged.rft}%, endlineSheet=${endlineData._endlineSheet}`);
      // this.logger.log(`📈 HTM: Final merged data summary: DATA_BCSL(slth=${baseRecord.slth}, congKh=${baseRecord.congKh}) + ENDLINE(tongKiem=${endlineData.tongKiem}, rft=${endlineData.rft}%)`);
      
      return merged;
      return merged;
    } catch (error) {
      this.logger.error(`❌ HTM: Failed to merge production data with ENDLINE:`, error);
      return null;
    }
  }

  /**
   * Get production data with optional team index filter
   * @param factory - Factory name (TS1, TS2, TS3, ALL)
   * @param teamIndex - Optional team index (0=Tổ 1, 1=Tổ 2, etc.) for ENDLINE filtering
   */
  async getProductionDataWithFilter(factory: string, teamIndex?: number): Promise<any[]> {
    // When teamIndex is provided, return empty array
    // Controller will use getEndlineDataByRowIndex instead
    if (teamIndex !== undefined) {
      this.logger.log(`🔍 HTM: teamIndex provided, should use getEndlineDataByRowIndex instead`);
      return [];
    }
    
    return this.getProductionData(factory);
  }

  async getProductionData(factory: string, bypassCache: boolean = true): Promise<any[]> {
    try {
      if (this.isQuotaExceeded && Date.now() < this.quotaResetTime) {
        this.logger.warn(`⚠️ HTM: Quota exceeded, using cache`);
        const cached = this.dataCache.get(`production_${factory}`);
        if (cached) return cached.data;
        return [];
      }
      
      const cacheKey = `production_${factory}`;
      const cached = this.dataCache.get(cacheKey);
      const now = Date.now();
      
      // ⚠️ ALWAYS BYPASS CACHE for TV real-time updates (bypassCache default = true)
      if (!bypassCache && cached && (now - cached.timestamp) < this.CACHE_TTL) {
        return cached.data;
      }
      
      // Get ranges from ENV or use defaults
      const htmDataRange = this.configService.get<string>('HTM_DATA_RANGE') || 'A1:CO50';
      const serverFactory = factory.toUpperCase();
      
      // Determine which ENDLINE sheet and range to use based on time
      const { sheetName: rftSheetName, range: rftRange } = this.getEndlineSheetConfig(serverFactory);
      
      // this.logger.log(`📖 HTM: Reading 2 sheets in parallel - 1) DATA BCSL HTM (${htmDataRange}), 2) ${rftSheetName} (${rftRange})`);
      const fetchStart = Date.now();
      
      const [productionValues, rftValues] = await Promise.all([
        this.getSheetData('DATA BCSL HTM', htmDataRange),
        this.getSheetData(rftSheetName, rftRange)
      ]);
      
      const fetchTime = Date.now() - fetchStart;
      // this.logger.log(`✅ HTM: Fetched both sheets in ${fetchTime}ms - DATA BCSL rows: ${productionValues.length}, ENDLINE rows: ${rftValues.length}`);
      
      if (productionValues.length <= 1) {
        this.logger.warn(`HTM: No data found in production sheet`);
        return [];
      }

      const rftDataMap = this.parseRFTData(rftValues);
      const headers = productionValues[0];
      const data = productionValues.slice(1);
      
      const formattedData = data.map((row, index) => {
        const maChuyenLine = row[0] || '';
        const rftData = rftDataMap.get(maChuyenLine);
        
        const record: any = {
          id: index,
          maChuyen: row[0] || '',
          maChuyenLine: row[0] || '',
          nhaMay: row[1] || '',
          line:row[2] || '',
          to: row[3] || '',
          maHang: row[4] || '',
          slth: this.parseNumber(row[5]),
          congKh: this.parseNumber(row[6]),
          congTh: this.parseNumber(row[7]),
          pphKh: this.parsePercentage(row[8]),
          pphTh: this.parsePercentage(row[9]),
          phanTramHtPph: this.parsePercentage(row[10]),
          gioSx: this.parseNumber(row[11]),
          pphThNew: 0,
          ldCoMat: this.parseNumber(row[12]),
          ldLayout: this.parseNumber(row[13]),
          ldHienCo: this.parseNumber(row[14]),
          nangSuat: this.parseNumber(row[15]),
          pphTarget: this.parseNumber(row[16]),
          pphGiao: this.parseNumber(row[17]),
          phanTramGiao: this.parsePercentage(row[18]),
          targetNgay: this.parseNumber(row[19]),
          targetGio: this.parseNumber(row[20]),
          lkth: this.parseNumber(row[21]),
          phanTramHt: this.parsePercentage(row[22]),
          hourlyData: this.buildHourlyDataWithRFT(row, rftData),
          lean: row[45] || '',
          phanTram100: this.parseNumber(row[46]),
          t: this.parseNumber(row[47]),
          l: this.parseNumber(row[48]),
          image: row[49] || '',
          lkkh: this.parseNumber(row[50]),
          bqTargetGio: this.parseNumber(row[51]),
          slcl: this.parseNumber(row[52]),
          rft: this.parseRFT(row[53]),
          tongKiem: this.parseNumber(row[54]),
          mucTieuRft: this.parsePercentage(row[55]),
          lktuiloi: this.parseNumber(row[56]),
          nhipsx: this.parseNumber(row[57]),
          tansuat: this.parseNumber(row[58]),
          tyleloi: this.parsePercentage(row[59]),
          QCTarget: this.parseNumber(row[66]),
          thoigianlamviec: this.parseNumber(row[89]),
          tongKiemNew: this.parseNumber(row[90]),
          tongDatNew: this.parseNumber(row[91]),
          tongLoiNew: this.parseNumber(row[92]),
        };
        
        // Calculate derived fields (same as google-sheets.service.ts)
        const timeSlotsReverse = ['h2000', 'h1900', 'h1800', 'h1630', 'h1530', 'h1430', 'h1330', 'h1130', 'h1030', 'h930', 'h830'];
        let latestTongDat = 0;
        for (const slot of timeSlotsReverse) {
          if (record.hourlyData[slot] && record.hourlyData[slot].tongDat > 0) {
            latestTongDat = record.hourlyData[slot].tongDat;
            break;
          }
        }
        
        const calculatedTongKiem = record.rft > 0 
          ? Math.round(latestTongDat / (record.rft / 100))
          : latestTongDat;
        
        record.tongKiem = calculatedTongKiem;
        record.tongDat = latestTongDat;
        record.lktuiloi = calculatedTongKiem - latestTongDat;
        
        let latestSlotData = null;
        for (const slot of timeSlotsReverse) {
          if (record.hourlyData[slot] && record.hourlyData[slot].tongDat > 0) {
            latestSlotData = record.hourlyData[slot];
            break;
          }
        }
        
        if (latestSlotData) {
          record.loi1 = latestSlotData.loi1 || 0;
          record.loi2 = latestSlotData.loi2 || 0;
          record.loi3 = latestSlotData.loi3 || 0;
          record.loi4 = latestSlotData.loi4 || 0;
          record.loi5 = latestSlotData.loi5 || 0;
          record.loi6 = latestSlotData.loi6 || 0;
          record.loi7 = latestSlotData.loi7 || 0;
          record.loi8 = latestSlotData.loi8 || 0;
          record.loi9 = latestSlotData.loi9 || 0;
          record.loi10 = latestSlotData.loi10 || 0;
          record.loi11 = latestSlotData.loi11 || 0;
          record.loi12 = latestSlotData.loi12 || 0;
          record.loi13 = latestSlotData.loi13 || 0;
          record.loi14 = latestSlotData.loi14 || 0;
        }
        
        const congTh = this.parseNumber(row[7]) || 0;
        record.pphThNew = congTh > 0 ? Math.round((latestTongDat / congTh / 8) * 100) / 100 : 0;
        record.percentagePPHNew = record.pphKh > 0 ? (record.pphThNew / record.pphKh) * 100 : 0;
        record.percentageSLTHNew = record.tongDat > 0 ? (record.tongDat / record.lkkh) * 100 : 0;
        record.diffPercentagePPHNew = record.percentagePPHNew > 0 ? record.percentagePPHNew - 100 : 0;
        record.diffPercentageSLTHNew = record.percentageSLTHNew > 0 ? record.percentageSLTHNew - 100 : 0;
        
        const totalErrors = record.loi1 + record.loi2 + record.loi3 + record.loi4 + 
                           record.loi5 + record.loi6 + record.loi7 + record.loi8 + 
                           record.loi9 + record.loi10 + record.loi11 + record.loi12 + 
                           record.loi13 + record.loi14;
        
        record.lktuiloiNew = totalErrors;
        record.tuiChuaTaiChe = record.lktuiloi - totalErrors;
        record.tuiChuaTaiCheNew = record.tongLoiNew - totalErrors;
        
        // Calculated diff/ratio fields
        record.diffLdCoMatLayout = record.ldCoMat - record.ldLayout;
        record.diffLkthTarget = record.lkth - record.targetNgay;
        record.diffRftTarget = record.rft - 92;
        record.diffBqTargetSlcl = record.bqTargetGio - record.slcl;
        record.ratioPphThKh = record.pphKh > 0 ? record.pphTh - record.pphKh : 0;
        record.ratioPphThKhNew = record.pphKh > 0 ? record.pphThNew - record.pphKh : 0;
        record.diffPhanTramHt100 = record.phanTramHt - 100;
        record.diffPhanTramHtPph100 = record.phanTramHtPph - 100;
        
        // Compatibility aliases
        record.team = record.to;
        record.actual_quantity = record.slth;
        record.planned_work = record.congKh;
        record.actual_work = record.congTh;
        record.planned_pph = record.pphKh;
        record.actual_pph = record.pphTh;
        record.daily_target = record.targetNgay;
        record.hourly_target = record.targetGio;
        record.cumulative_actual = record.lkth;
        
        return record;
      });

      this.dataCache.set(cacheKey, { data: formattedData, timestamp: Date.now() });

      return formattedData;
    } catch (error) {
      if (error.message?.includes('Quota exceeded')) {
        this.isQuotaExceeded = true;
        this.quotaResetTime = Date.now() + 60000;
      }
      
      this.logger.error(`HTM: Failed to get production data for ${factory}:`, error);
      return [];
    }
  }

  /**
   * Determine which ENDLINE sheet to use based on current time
   * ENDLINE_BEFORE_DATA: 0h-8:30 AM
   * ENDLINE_DAILY_DATA: After 8:30 AM
   */
  private getEndlineSheetConfig(serverFactory: string): { sheetName: string; range: string } {
    // Get current Vietnam time
    const vietnamTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const currentHour = vietnamTime.getHours();
    const currentMinute = vietnamTime.getMinutes();
    const currentTimeInMinutes = currentHour * 60 + currentMinute;
    
    // 8:30 AM = 510 minutes from midnight
    // Replace 8:30 to 8:00 if you want to switch at 8:00 AM
    // const cutoffTime = 8 * 60 + 30; // 510 minutes
    const cutoffTime = 8 * 60; // 480 minutes
    
    const isBefore830 = currentTimeInMinutes < cutoffTime;
    const sheetName = isBefore830 
      ? (this.configService.get<string>('ENDLINE_BEFORE_SHEET') || 'ENDLINE_BEFORE_DATA')
      : (this.configService.get<string>('ENDLINE_DAILY_SHEET') || 'ENDLINE_DAILY_DATA');
    
    // Determine range based on factory
    let range: string;
    
    if (isBefore830) {
      // Use ENDLINE_BEFORE ranges
      switch(serverFactory.toUpperCase()) {
        case 'TS1':
          range = this.configService.get<string>('ENDLINE_BEFORE_TS1_RANGE') || 'A1:AJ12';
          break;
        case 'TS2':
          range = this.configService.get<string>('ENDLINE_BEFORE_TS2_RANGE') || 'A14:AJ21';
          break;
        case 'TS3':
          range = this.configService.get<string>('ENDLINE_BEFORE_TS3_RANGE') || 'A23:AJ33';
          break;
        default:
          range = this.configService.get<string>('ENDLINE_BEFORE_ALL_RANGE') || 'A1:AJ50';
      }
    } else {
      // Use ENDLINE_DAILY ranges
      switch(serverFactory.toUpperCase()) {
        case 'TS1':
          range = this.configService.get<string>('ENDLINE_DAILY_TS1_RANGE') || 'A1:AJ12';
          break;
        case 'TS2':
          range = this.configService.get<string>('ENDLINE_DAILY_TS2_RANGE') || 'A14:AJ21';
          break;
        case 'TS3':
          range = this.configService.get<string>('ENDLINE_DAILY_TS3_RANGE') || 'A23:AJ33';
          break;
        default:
          range = this.configService.get<string>('ENDLINE_DAILY_ALL_RANGE') || 'A1:AJ50';
      }
    }
    
    // this.logger.log(`⏰ HTM ENDLINE Sheet Selection: Time=${vietnamTime.toLocaleTimeString('vi-VN')}, Before8:30=${isBefore830}, Sheet=${sheetName}, Range=${range}, Factory=${serverFactory}`);
    
    return { sheetName, range };
  }

  /**
   * Parse NEW ENDLINE RFT data structure
   * Column mapping:
   * A: NM (Nhà máy), B: LINE, C: 16, D: 1, E: TỔ
   * F: TỔNG KIỂM, G: ĐẠT LẦN 1, H: TỔNG ĐẠT
   * I-V: 14 error types (Lỗi 1-14)
   * W: RFT
   * X-AH: Time slots (8H30-20H00) - 11 columns
   * AI: DỮ LIỆU (Data/Notes column)
   * AJ: NGUYÊN NHÂN (Root Cause/Reason column)
   */
  private parseRFTData(rftValues: any[][]): Map<string, any> {
    const rftMap = new Map<string, any>();
    
    if (!rftValues || rftValues.length === 0) {
      this.logger.warn('HTM: No RFT data available');
      return rftMap;
    }

    // Skip header row (row 0)
    const dataRows = rftValues.slice(1);
    
    // Time slot mapping: X(23)-AH(33) = 11 slots
    const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
    const TIME_SLOT_START_COL = 23; // Column X (0-indexed)
    
    // Track current NM and LINE for fill-forward logic
    let currentNhaMay = '';
    let currentLine = '';
    
    for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
      const row = dataRows[rowIdx];
      
      // Column A: NM (Nhà máy), B: LINE, E: Tổ (index 4)
      let nhaMay = (row[0] || '').toString().trim();
      let line = (row[1] || '').toString().trim();
      const to = (row[4] || '').toString().trim(); // Column E: Tổ
      
      // Fill-forward logic: If NM or LINE is empty, use the last known value
      if (!nhaMay && currentNhaMay) {
        nhaMay = currentNhaMay;
      } else if (nhaMay) {
        currentNhaMay = nhaMay;
      }
      
      if (!line && currentLine) {
        line = currentLine;
      } else if (line) {
        currentLine = line;
      }
      
      // Skip if essential data is missing
      if (!nhaMay || !line || !to) {
        continue;
      }
      
      // Construct maChuyenLine key (e.g., "KVHB07M01")
      const maChuyenLine = this.constructMaChuyenLine(nhaMay, line, to);
      if (!maChuyenLine) {
        continue;
      }
      
      // Parse cumulative data (columns F-V)
      const tongKiem = this.parseNumber(row[5]) || 0;      // Column F
      const datLan1 = this.parseNumber(row[6]) || 0;       // Column G
      const tongDat = this.parseNumber(row[7]) || 0;       // Column H
      
      // Parse 14 error types (columns I-V, indices 8-21)
      const loi1 = this.parseNumber(row[8]) || 0;   // I: DÍNH KEO
      const loi2 = this.parseNumber(row[9]) || 0;   // J: LỖ KIM
      const loi3 = this.parseNumber(row[10]) || 0;  // K: LỖI ĐƯỜNG MAY
      const loi4 = this.parseNumber(row[11]) || 0;  // L: LỖI DA
      const loi5 = this.parseNumber(row[12]) || 0;  // M: MÀU VÂN KHÔNG ĐỒNG BỘ
      const loi6 = this.parseNumber(row[13]) || 0;  // N: LỖI HW
      const loi7 = this.parseNumber(row[14]) || 0;  // O: DÂY KÉO GỢN SÓNG
      const loi8 = this.parseNumber(row[15]) || 0;  // P: LEM SƠN BIÊN
      const loi9 = this.parseNumber(row[16]) || 0;  // Q: CHI TIẾT NHĂN VÀ GẤP NẾP
      const loi10 = this.parseNumber(row[17]) || 0; // R: LOGO NGHIÊNG XÉO
      const loi11 = this.parseNumber(row[18]) || 0; // S: ÉP MỜ
      const loi12 = this.parseNumber(row[19]) || 0; // T: CHI TIẾT KHÔNG THẲNG HÀNG
      const loi13 = this.parseNumber(row[20]) || 0; // U: LỖI DÁNG
      const loi14 = this.parseNumber(row[21]) || 0; // V: LỖI KHÁC
      
      // Parse RFT from column W (index 22)
      const rft = this.parseNumber(row[22]) || 0;   // W: RFT%
      
      // Parse columns AI and AJ (indices 34 and 35)
      const duLieu = (row[34] || '').toString().trim();    // AI: DỮ LIỆU
      const nguyenNhan = (row[35] || '').toString().trim(); // AJ: NGUYÊN NHÂN
      
      // Parse hourly data from columns X-AH (indices 23-33)
      const hourlyErrors: any = {};
      
      for (let i = 0; i < timeSlots.length; i++) {
        const timeSlot = timeSlots[i];
        const colIndex = TIME_SLOT_START_COL + i;
        const hourlyValue = this.parseNumber(row[colIndex]) || 0;
        
        // Store hourly data - dữ liệu đã được sum nên chỉ cần lấy giá trị
        hourlyErrors[timeSlot] = {
          rft: rft,              // RFT chung cho cả ngày
          tongKiem: tongKiem,    // Cumulative
          datLan1: datLan1,      // Cumulative
          tongDat: tongDat,      // Cumulative
          hourlyProduction: hourlyValue, // Giá trị sản lượng của khung giờ đó
          loi1, loi2, loi3, loi4, loi5, loi6, loi7,
          loi8, loi9, loi10, loi11, loi12, loi13, loi14,
          duLieu,               // AI: DỮ LIỆU
          nguyenNhan,          // AJ: NGUYÊN NHÂN
        };
      }
      
      rftMap.set(maChuyenLine, hourlyErrors);
    }
    
    return rftMap;
  }

  private buildHourlyDataWithRFT(productionRow: any[], rftData: any): any {
    const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
    const hourlyData: any = {};
    
    const baseProductionCol = 23;
    const basePercentageCol = 34;
    const rftFromSheet = this.parseRFT(productionRow[53]) || 0;
    const targetGio = this.parseNumber(productionRow[20]) || 0;
    
    const cumulativeErrors = {
      tongKiem: 0,
      tongKiemNew: 0,
      datLan1: 0,
      tongDat: 0,
      loi1: 0, loi2: 0, loi3: 0, loi4: 0, loi5: 0, loi6: 0, loi7: 0,
      loi8: 0, loi9: 0, loi10: 0, loi11: 0, loi12: 0, loi13: 0, loi14: 0,
      tuiChuaTaiChe: 0,
    };
    
    for (let i = 0; i < timeSlots.length; i++) {
      const timeSlot = timeSlots[i];
      const sanluong = this.parseNumber(productionRow[baseProductionCol + i]) || 0;
      const percentage = this.parsePercentage(productionRow[basePercentageCol + i]) || 0;
      
      const rftErrors = rftData?.[timeSlot] || {};
      const currentTongDat = rftErrors.tongDat || 0;
      
      cumulativeErrors.datLan1 += rftErrors.datLan1 || 0;
      cumulativeErrors.tongDat += rftErrors.tongDat || 0;
      cumulativeErrors.tongKiemNew += rftErrors.tongKiem || 0;
      cumulativeErrors.loi1 += rftErrors.loi1 || 0;
      cumulativeErrors.loi2 += rftErrors.loi2 || 0;
      cumulativeErrors.loi3 += rftErrors.loi3 || 0;
      cumulativeErrors.loi4 += rftErrors.loi4 || 0;
      cumulativeErrors.loi5 += rftErrors.loi5 || 0;
      cumulativeErrors.loi6 += rftErrors.loi6 || 0;
      cumulativeErrors.loi7 += rftErrors.loi7 || 0;
      cumulativeErrors.loi8 += rftErrors.loi8 || 0;
      cumulativeErrors.loi9 += rftErrors.loi9 || 0;
      cumulativeErrors.loi10 += rftErrors.loi10 || 0;
      cumulativeErrors.loi11 += rftErrors.loi11 || 0;
      cumulativeErrors.loi12 += rftErrors.loi12 || 0;
      cumulativeErrors.loi13 += rftErrors.loi13 || 0;
      cumulativeErrors.loi14 += rftErrors.loi14 || 0;
      
      cumulativeErrors.tongKiem = rftFromSheet > 0 
        ? Math.round(cumulativeErrors.tongDat / (rftFromSheet / 100))
        : cumulativeErrors.tongDat;
      
      const calculateErrorPercentage = (errorCount: number) => {
        return cumulativeErrors.tongKiem > 0 
          ? (errorCount / cumulativeErrors.tongKiem) * 100 
          : 0;
      };
      
      const lktuiloi = cumulativeErrors.tongKiem - cumulativeErrors.tongDat;
      
      const totalCumulativeErrors = 
        cumulativeErrors.loi1 + cumulativeErrors.loi2 + cumulativeErrors.loi3 + 
        cumulativeErrors.loi4 + cumulativeErrors.loi5 + cumulativeErrors.loi6 + 
        cumulativeErrors.loi7 + cumulativeErrors.loi8 + cumulativeErrors.loi9 + 
        cumulativeErrors.loi10 + cumulativeErrors.loi11 + cumulativeErrors.loi12 + 
        cumulativeErrors.loi13 + cumulativeErrors.loi14;
      
      const tuiChuaTaiChe = lktuiloi - totalCumulativeErrors;
      const tuiChuaTaiCheNew = (productionRow[92] || 0) - totalCumulativeErrors;
      const sanluongNew = currentTongDat;
      const percentageNew = targetGio > 0 ? (currentTongDat / targetGio) * 100 : 0;
      
      // Get duLieu and nguyenNhan from rftErrors if available
      const duLieu = rftErrors.duLieu || '';
      const nguyenNhan = rftErrors.nguyenNhan || '';
      
      hourlyData[timeSlot] = {
        sanluong,
        percentage,
        sanluongNew,
        percentageNew,
        rft: rftFromSheet,
        tongKiemV2: cumulativeErrors.tongKiemNew,
        datLan1: cumulativeErrors.datLan1,
        tongDat: cumulativeErrors.tongDat,
        lktuiloi: lktuiloi,
        loi1: cumulativeErrors.loi1,
        loi2: cumulativeErrors.loi2,
        loi3: cumulativeErrors.loi3,
        loi4: cumulativeErrors.loi4,
        loi5: cumulativeErrors.loi5,
        loi6: cumulativeErrors.loi6,
        loi7: cumulativeErrors.loi7,
        loi8: cumulativeErrors.loi8,
        loi9: cumulativeErrors.loi9,
        loi10: cumulativeErrors.loi10,
        loi11: cumulativeErrors.loi11,
        loi12: cumulativeErrors.loi12,
        loi13: cumulativeErrors.loi13,
        loi14: cumulativeErrors.loi14,
        errorpercentage1: calculateErrorPercentage(cumulativeErrors.loi1),
        errorpercentage2: calculateErrorPercentage(cumulativeErrors.loi2),
        errorpercentage3: calculateErrorPercentage(cumulativeErrors.loi3),
        errorpercentage4: calculateErrorPercentage(cumulativeErrors.loi4),
        errorpercentage5: calculateErrorPercentage(cumulativeErrors.loi5),
        errorpercentage6: calculateErrorPercentage(cumulativeErrors.loi6),
        errorpercentage7: calculateErrorPercentage(cumulativeErrors.loi7),
        errorpercentage8: calculateErrorPercentage(cumulativeErrors.loi8),
        errorpercentage9: calculateErrorPercentage(cumulativeErrors.loi9),
        errorpercentage10: calculateErrorPercentage(cumulativeErrors.loi10),
        errorpercentage11: calculateErrorPercentage(cumulativeErrors.loi11),
        errorpercentage12: calculateErrorPercentage(cumulativeErrors.loi12),
        errorpercentage13: calculateErrorPercentage(cumulativeErrors.loi13),
        errorpercentage14: calculateErrorPercentage(cumulativeErrors.loi14),
        tuiChuaTaiChe: tuiChuaTaiChe,
        tuiChuaTaiCheNew: tuiChuaTaiCheNew,
        duLieu: duLieu,           // AI: DỮ LIỆU
        nguyenNhan: nguyenNhan,   // AJ: NGUYÊN NHÂN
      };
    }
    
    return hourlyData;
  }

  /**
   * Construct maChuyenLine key from NM, LINE, TỔ
   * Example: TS1 + LINE 1 + TỔ 1 -> KVHB07M01
   * This mapping should match your actual line codes
   */
  private constructMaChuyenLine(nhaMay: string, line: string, to: string): string | null {
    // Extract factory number (TS1 -> 1, TS2 -> 2, TS3 -> 3)
    const factoryMatch = nhaMay.match(/TS(\d+)/);
    if (!factoryMatch) {
      this.logger.warn(`Cannot extract factory number from: ${nhaMay}`);
      return null;
    }
    
    // Extract line number
    const lineNumber = this.extractLineNumber(line);
    if (!lineNumber) return null;
    
    // Extract team number
    const teamNumber = this.extractTeamNumber(to);
    
    // Construct maChuyenLine format: KVHB07M{lineNumber}{teamNumber}
    // Adjust this logic based on your actual naming convention
    const maChuyenLine = `KVHB07M${lineNumber.padStart(2, '0')}`;
    
    return maChuyenLine;
  }

  private extractLineNumber(lineValue: string): string {
    const match = lineValue.match(/\d+/);
    return match ? match[0] : '1';
  }

  private extractTeamNumber(teamValue: string): string {
    const match = teamValue.match(/\d+/);
    return match ? match[0] : '1';
  }

  private parseRFT(value: any): number {
    if (typeof value === 'string' && (value.includes('#DIV') || value.includes('#N/A'))) {
      return 0;
    }
    return this.parsePercentage(value);
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

  private parseNumber(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * 🚀 NEW: Get checksum data from BOTH ENDLINE sheets (BEFORE + DAILY)
   * This method reads ALL columns A:AJ from both sheets to detect changes
   * Used by listener service for comprehensive change detection
   */
  async getBothEndlineSheetsChecksumData(factory: string, rowIndex: number): Promise<{
    before: any | null;
    daily: any | null;
  }> {
    try {
      const serverFactory = factory.toUpperCase();
      
      // Get ranges for both sheets
      const beforeSheetName = this.configService.get<string>('ENDLINE_BEFORE_SHEET') || 'ENDLINE_BEFORE_DATA';
      const dailySheetName = this.configService.get<string>('ENDLINE_DAILY_SHEET') || 'ENDLINE_DAILY_DATA';
      
      let beforeRange: string;
      let dailyRange: string;
      
      // Determine ranges based on factory
      switch(serverFactory) {
        case 'TS1':
          beforeRange = this.configService.get<string>('ENDLINE_BEFORE_TS1_RANGE') || 'A1:AJ12';
          dailyRange = this.configService.get<string>('ENDLINE_DAILY_TS1_RANGE') || 'A1:AJ12';
          break;
        case 'TS2':
          beforeRange = this.configService.get<string>('ENDLINE_BEFORE_TS2_RANGE') || 'A14:AJ21';
          dailyRange = this.configService.get<string>('ENDLINE_DAILY_TS2_RANGE') || 'A14:AJ21';
          break;
        case 'TS3':
          beforeRange = this.configService.get<string>('ENDLINE_BEFORE_TS3_RANGE') || 'A23:AJ33';
          dailyRange = this.configService.get<string>('ENDLINE_DAILY_TS3_RANGE') || 'A23:AJ33';
          break;
        default:
          beforeRange = this.configService.get<string>('ENDLINE_BEFORE_ALL_RANGE') || 'A1:AJ50';
          dailyRange = this.configService.get<string>('ENDLINE_DAILY_ALL_RANGE') || 'A1:AJ50';
      }
      
      // this.logger.log(`🔍 HTM: Reading BOTH ENDLINE sheets for checksum - factory=${factory}, rowIndex=${rowIndex}`);
      // this.logger.log(`   BEFORE: ${beforeSheetName}!${beforeRange}`);
      // this.logger.log(`   DAILY: ${dailySheetName}!${dailyRange}`);
      
      // Read both sheets in parallel
      const [beforeValues, dailyValues] = await Promise.all([
        this.getSheetData(beforeSheetName, beforeRange).catch(err => {
          this.logger.warn(`⚠️ Failed to read BEFORE sheet: ${err.message}`);
          return null;
        }),
        this.getSheetData(dailySheetName, dailyRange).catch(err => {
          this.logger.warn(`⚠️ Failed to read DAILY sheet: ${err.message}`);
          return null;
        })
      ]);
      
      // Parse both datasets
      const beforeData = this.parseEndlineRowData(beforeValues, rowIndex, 'BEFORE');
      const dailyData = this.parseEndlineRowData(dailyValues, rowIndex, 'DAILY');
      
      return { before: beforeData, daily: dailyData };
      
    } catch (error) {
      this.logger.error(`❌ HTM: Error reading both ENDLINE sheets:`, error);
      return { before: null, daily: null };
    }
  }

  /**
   * Parse a specific row from ENDLINE sheet data (ALL columns A:AJ)
   */
  private parseEndlineRowData(values: any[][] | null, rowIndex: number, sheetType: string): any | null {
    if (!values || values.length <= 1) {
      return null;
    }
    
    const dataRows = values.slice(1); // Skip header
    
    if (rowIndex < 0 || rowIndex >= dataRows.length) {
      return null;
    }
    
    // Fill-forward logic for NM and LINE
    let currentNhaMay = '';
    let currentLine = '';
    
    for (let i = 0; i <= rowIndex; i++) {
      const row = dataRows[i];
      const rowNM = (row[0] || '').toString().trim();
      const rowLINE = (row[1] || '').toString().trim();
      if (rowNM) currentNhaMay = rowNM;
      if (rowLINE) currentLine = rowLINE;
    }
    
    const targetRow = dataRows[rowIndex];
    
    // Parse ALL columns A:AJ (indices 0-35)
    const data = {
      sheetType,
      // A-E: Basic info
      nhaMay: (targetRow[0] || '').toString().trim() || currentNhaMay,
      line: (targetRow[1] || '').toString().trim() || currentLine,
      col16: (targetRow[2] || '').toString().trim(),
      col1: (targetRow[3] || '').toString().trim(),
      to: (targetRow[4] || '').toString().trim(),
      // F-H: QC summary
      tongKiem: this.parseNumber(targetRow[5]) || 0,
      datLan1: this.parseNumber(targetRow[6]) || 0,
      tongDat: this.parseNumber(targetRow[7]) || 0,
      // I-V: 14 error types
      loi1: this.parseNumber(targetRow[8]) || 0,
      loi2: this.parseNumber(targetRow[9]) || 0,
      loi3: this.parseNumber(targetRow[10]) || 0,
      loi4: this.parseNumber(targetRow[11]) || 0,
      loi5: this.parseNumber(targetRow[12]) || 0,
      loi6: this.parseNumber(targetRow[13]) || 0,
      loi7: this.parseNumber(targetRow[14]) || 0,
      loi8: this.parseNumber(targetRow[15]) || 0,
      loi9: this.parseNumber(targetRow[16]) || 0,
      loi10: this.parseNumber(targetRow[17]) || 0,
      loi11: this.parseNumber(targetRow[18]) || 0,
      loi12: this.parseNumber(targetRow[19]) || 0,
      loi13: this.parseNumber(targetRow[20]) || 0,
      loi14: this.parseNumber(targetRow[21]) || 0,
      // W: RFT
      rft: this.parseNumber(targetRow[22]) || 0,
      // X-AH: 11 time slots (columns 23-33)
      h830: this.parseNumber(targetRow[23]) || 0,
      h930: this.parseNumber(targetRow[24]) || 0,
      h1030: this.parseNumber(targetRow[25]) || 0,
      h1130: this.parseNumber(targetRow[26]) || 0,
      h1330: this.parseNumber(targetRow[27]) || 0,
      h1430: this.parseNumber(targetRow[28]) || 0,
      h1530: this.parseNumber(targetRow[29]) || 0,
      h1630: this.parseNumber(targetRow[30]) || 0,
      h1800: this.parseNumber(targetRow[31]) || 0,
      h1900: this.parseNumber(targetRow[32]) || 0,
      h2000: this.parseNumber(targetRow[33]) || 0,
      // AI-AJ: Notes
      duLieu: (targetRow[34] || '').toString().trim(),
      nguyenNhan: (targetRow[35] || '').toString().trim(),
    };
    
    return data;
  }
}
