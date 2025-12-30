import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

@Injectable()
export class GoogleSheetsService {
  private readonly logger = new Logger(GoogleSheetsService.name);
  private sheets: any;
  
  // In-memory cache to reduce API calls
  private dataCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 30000; // 30 seconds cache (reduced from 2 minutes for real-time)
  
  // Quota management
  private isQuotaExceeded = false;
  private quotaResetTime = 0;
  private requestCount = 0;
  private requestWindowStart = Date.now();
  
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

      // Parse JSON exactly like the working NextJS implementation
      let credentials;
      try {
        // Use same approach as NextJS: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}')
        credentials = JSON.parse(serviceAccountKey || '{}');
        
        // Validate that we got actual credentials
        if (!credentials.type || credentials.type !== 'service_account') {
          throw new Error('Invalid service account credentials structure');
        }
        
      } catch (parseError) {
        this.logger.error('❌ Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY JSON:', parseError);
        this.logger.error('Make sure the JSON is properly formatted in .env file');
        
        // Don't throw error, just set sheets to null and use mock data
        this.logger.warn('Will use mock data instead of Google Sheets');
        this.sheets = null;
        return;
      }

      // Validate required fields in credentials
      const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
      for (const field of requiredFields) {
        if (!credentials[field]) {
          this.logger.error(`Missing required field in service account key: ${field}`);
          this.sheets = null;
          return;
        }
      }

      // Initialize exactly like NextJS
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Same scope as NextJS
      });

      this.sheets = google.sheets({ version: 'v4', auth });
      
      // Test the connection
      await this.testConnection();
      
    } catch (error) {
      this.logger.error('Failed to initialize Google Sheets API:', error);
      
      // Don't throw error, allow app to start but log the issue
      this.logger.warn('Google Sheets service will be unavailable. Please check your configuration.');
      this.sheets = null;
    }
  }

  private async testConnection() {
    try {
      const sheetId = this.configService.get<string>('GOOGLE_SHEET_ID');
      if (sheetId && this.sheets) {
        // Try to get basic spreadsheet info
        await this.sheets.spreadsheets.get({
          spreadsheetId: sheetId,
          fields: 'properties.title'
        });
      }
    } catch (error) {
      this.logger.warn('Google Sheets connection test failed:', error.message);
    }
  }

async getSheetData(sheetName: string, range: string = 'A1:C050'): Promise<any[][]> {
    try {
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID');

      // Single attempt only - no retries to save quota
      try {
        const response = await this.sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!${range}`,
        });

        return response.data.values || [];
      } catch (error) {
        throw error;
      }
    } catch (error) {
      this.logger.error(`❌ Failed to fetch data from sheet ${sheetName}:`, error);
      
      // Return empty array as fallback
      this.logger.warn('Returning empty array as fallback');
      return [];
    }
  }


   async getProductionLinesList(): Promise<Array<{code: string; nhaMay: string; line: string; to: string; percentagePPH: string; percentageHT: string; rft: string}>>{
    try {

      const values = await this.getSheetData('DATA BCSL HTM', 'A1:C040'); // Extend range to include RFT column (BB)

      if (values.length <= 1) {
        this.logger.warn(`No data found in sheet`);
        return [];
      }

      const data = values.slice(1);
      const linesSet = new Set<string>();

      // Extract unique production lines
      const linesList = data
        .map((row, rowIndex) => {
          const code = (row[0] || '').toString().trim(); // Column A: MÃ CHUYỀN
          const nhaMay = (row[1] || '').toString().trim(); // Column B: NHÀ MÁY
          const line = (row[2] || '').toString().trim(); // Column C: LINE
          const to = (row[3] || '').toString().trim(); // Column D: TỔ
          const percentagePPH = row[10]; // Column K: %HT PPH
          const percentageHT = row[22]; // Column W: %HT
          const rft = row[53]; // Column BB: RFT

          // Skip invalid rows:
          // 1. Empty code
          // 2. Non-standard codes (e.g., "LKKH", headers, etc.)
          // 3. Codes that don't start with "KVHB" or "KV"
          if (code === '' || 
              !code.startsWith('KVHB') && !code.startsWith('KV') ||
              code === 'LKKH' || 
              code.includes('MÃ CHUYỀN')) {
            return null;
          }

          const uniqueKey = `${code}`;
          if (!linesSet.has(uniqueKey)) {
            linesSet.add(uniqueKey);
            
            // Parse values with proper handling (same as getProductionData)
            const parsedPPH = this.parsePercentage(percentagePPH);
            const parsedHT = this.parsePercentage(percentageHT);
            const parsedRFT = this.parseRFT(rft);
            
            
            return {
              code: code,
              nhaMay: nhaMay,
              line: line,
              to: to, // Keep original value, even if empty
              percentagePPH: parsedPPH === 0 ? '0.00' : parsedPPH.toFixed(2),
              percentageHT: parsedHT === 0 ? '0.00' : parsedHT.toFixed(2),
              rft: parsedRFT === 0 ? '0.00' : parsedRFT.toFixed(2)
            };
          }
          return null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => a.code.localeCompare(b.code));

      return linesList;

    } catch (error) {
      this.logger.error(`❌ Error fetching production lines list:`, error);

      // Return mock data as fallback
      return [
        { code: 'KVHB07M01', nhaMay: 'TS1', line: 'LINE 1', to: 'TỔ 1', percentagePPH: '', percentageHT: '', rft: '' },
        { code: 'KVHB07M02', nhaMay: 'TS1', line: 'LINE 1', to: 'TỔ 2', percentagePPH: '', percentageHT: '', rft: '' },
        { code: 'KVHB07M18', nhaMay: 'TS2', line: 'LINE 18', to: 'TỔ 1', percentagePPH: '', percentageHT: '', rft: '' }
      ];
    }
  }

  async getProductionData(factory: string): Promise<any[]> {
    try {
      // Check quota status first
      if (this.isQuotaExceeded && Date.now() < this.quotaResetTime) {
        this.logger.warn(`⚠️ Quota exceeded, using cache until ${new Date(this.quotaResetTime).toLocaleTimeString()}`);
        const cached = this.dataCache.get(`production_${factory}`);
        if (cached) return cached.data;
        return []; // Return empty if no cache
      }
      
      // Check cache first to reduce API calls
      const cacheKey = `production_${factory}`;
      const cached = this.dataCache.get(cacheKey);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
        return cached.data;
      }
      
      
      // Lấy dữ liệu từ cả 2 sheets (sử dụng ENDLINE_DAILY_DATA thay vì DATA_RFT cũ)
      const [productionValues, rftValues] = await Promise.all([
        this.getSheetData('DATA BCSL HTM', 'A1:CO50'),
        this.getSheetData('ENDLINE_DAILY_DATA', 'A2:AS100')
      ]);
      
      if (productionValues.length <= 1) {
        this.logger.warn(`No data found in production sheet`);
        return [];
      }

      // Parse RFT data vào Map để lookup nhanh theo mã chuyền
      const rftDataMap = this.parseRFTData(rftValues);

      const headers = productionValues[0];
      const data = productionValues.slice(1);
      
      // this.logger.debug(`Headers found: ${headers.join(', ')}`);
      
      // Convert raw data theo chuẩn cột A-AS
      const formattedData = data.map((row, index) => {
        const maChuyenLine = row[0] || '';
        const rftData = rftDataMap.get(maChuyenLine);
        
        // Map theo đúng vị trí cột A-AS (chuẩn hóa theo yêu cầu)

        const record: any = {
          id: index,
          
          // Cột A-L: Thông tin cơ bản
          maChuyen: row[0] || '',               // A: MÃ CHUYỀN 
          maChuyenLine: row[0] || '',           // A: MÃ CHUYỀN (alias for compatibility)
          nhaMay: row[1] || '',                 // B: NHÀ MÁY  
          line: row[2] || '',                   // C: LINE
          to: row[3] || '',   // D: TỔ
          maHang: row[4] || '',                 // E: MÃ HÀNG
          slth: this.parseNumber(row[5]),       // F: SLTH
          congKh: this.parseNumber(row[6]),     // G: Công KH
          congTh: this.parseNumber(row[7]),     // H: Công TH
          pphKh: this.parsePercentage(row[8]),      // I: PPH KH
          pphTh: this.parsePercentage(row[9]),      // J: PPH TH
          phanTramHtPph: this.parsePercentage(row[10]), // K: %HT PPH (chuẩn hóa tên)
          gioSx: this.parseNumber(row[11]),     // L: GIỜ SX
          pphThNew: 0, // Will be calculated after hourlyData is built
          
          // Cột M-S: Nhân lực và hiệu suất
          ldCoMat: this.parseNumber(row[12]),   // M: LĐ CÓ MẶT
          ldLayout: this.parseNumber(row[13]),  // N: LĐ LAYOUT
          ldHienCo: this.parseNumber(row[14]),  // O: LĐ HIỆN CÓ
          nangSuat: this.parseNumber(row[15]),  // P: NĂNG SUẤT
          pphTarget: this.parseNumber(row[16]), // Q: PPH TARGET
          pphGiao: this.parseNumber(row[17]),   // R: PPH GIAO
          phanTramGiao: this.parsePercentage(row[18]), // S: %GIAO
          
          // Cột T-W: Mục tiêu và thực hiện
          targetNgay: this.parseNumber(row[19]), // T: TARGET NGÀY
          targetGio: this.parseNumber(row[20]),  // U: TARGET GIỜ
          lkth: this.parseNumber(row[21]),       // V: LKTH
          phanTramHt: this.parsePercentage(row[22]), // W: %HT (chuẩn hóa tên)
          
          // Cột X-AH: Dữ liệu sản lượng theo giờ (chuẩn hóa key names)
          // h830: this.parseNumber(row[23]),      // X: 8H30
          // h930: this.parseNumber(row[24]),      // Y: 9H30  
          // h1030: this.parseNumber(row[25]),     // Z: 10H30
          // h1130: this.parseNumber(row[26]),     // AA: 11H30
          // h1330: this.parseNumber(row[27]),     // AB: 13H30
          // h1430: this.parseNumber(row[28]),     // AC: 14H30
          // h1530: this.parseNumber(row[29]),     // AD: 15H30
          // h1630: this.parseNumber(row[30]),     // AE: 16H30
          // h1800: this.parseNumber(row[31]),     // AF: 18H00
          // h1900: this.parseNumber(row[32]),     // AG: 19H00
          // h2000: this.parseNumber(row[33]),     // AH: 20H00

          // percentageh830: this.parsePercentage(row[34]), // AI
          // percentageh930: this.parsePercentage(row[35]), // AJ
          // percentageh1030: this.parsePercentage(row[36]), // AK
          // percentageh1130: this.parsePercentage(row[37]), // AL
          // percentageh1330: this.parsePercentage(row[38]), // AM
          // percentageh1430: this.parsePercentage(row[39]), // AN
          // percentageh1530: this.parsePercentage(row[40]), // AO
          // percentageh1630: this.parsePercentage(row[41]), // AP
          // percentageh1800: this.parsePercentage(row[42]), // AQ
          // percentageh1900: this.parsePercentage(row[43]), // AR
          // percentageh2000: this.parsePercentage(row[44]), // AS

          // Hourly data object cho compatibility với RFT data integration
          hourlyData: this.buildHourlyDataWithRFT(row, rftData),

          // null hourlyData object for compatibility
          // '': this.parseNumber(row[34]),      // AI: (null)
          // '': this.parseNumber(row[35]),      // AJ: (null)
          // '': this.parseNumber(row[36]),      // AK: (null)
          // '': this.parseNumber(row[37]),      // AL: (null)
          // '': this.parseNumber(row[38]),      // AM: (null)
          // '': this.parseNumber(row[39]),      // AN: (null)
          // '': this.parseNumber(row[40]),      // AO: (null)
          // '': this.parseNumber(row[41]),      // AP: (null)
          // '': this.parseNumber(row[42]),      // AQ: (null)
          // '': this.parseNumber(row[43]),      // AR: (null)
          // '': this.parseNumber(row[44]),      // AS: (null)
          
          // Cột AT-AX: Thông tin bổ sung
          lean: row[45] || '',                  // AT: LEAN
          phanTram100: this.parseNumber(row[46]), // AU: 100% (chuẩn hóa tên)
          t: this.parseNumber(row[47]),         // AV: T
          l: this.parseNumber(row[48]),         // AW: L
          image: row[49] || '',                 // AX: IMAGE
          
          // Cột AY-BH: Chỉ số chất lượng
          lkkh: this.parseNumber(row[50]),      // AY: LKKH
          bqTargetGio: this.parseNumber(row[51]), // AZ: BQ TARGET GIỜ (chuẩn hóa tên)
          slcl: this.parseNumber(row[52]),      // BA: SLCL
          rft: this.parseRFT(row[53]),          // BB: RFT
          tongKiem: this.parseNumber(row[54]),  // BC: TỔNG KIỂM
          mucTieuRft: this.parsePercentage(row[55]), // BD: MỤC TIÊU RFT
          lktuiloi: this.parseNumber(row[56]),   // BE: LKTUỈ LỖI
          nhipsx: this.parseNumber(row[57]),    // BF: NHỊP SX
          tansuat: this.parseNumber(row[58]),   // BG: TẦN SUẤT
          tyleloi: this.parsePercentage(row[59]), // BH: TỶ LỆ LỖI
          loikeo: this.parseNumber(row[60]),   // BI: LỖI KEO
          loison: this.parseNumber(row[61]),   // BJ: LỖI SƠN
          loichi: this.parseNumber(row[62]),   // BK: LỖI CHỈ
          phanTramLoiKeo: this.parsePercentage(row[63]) * 100, // BL: % LỖI KEO
          phanTramLoiSon: this.parsePercentage(row[64]) * 100, // BM: % LỖI SƠN
          phanTramLoiChi: this.parsePercentage(row[65]) * 100, // BN: % LỖI CHỈ
          QCTarget: this.parseNumber(row[66]),                // BO: QC TARGET


          thoigianlamviec: this.parseNumber(row[89]), // CL: THỜI GIAN LÀM VIỆC
          tongKiemNew: this.parseNumber(row[90]), // CM: TỔNG KIỂM NEW (for comparison testing)
          tongDatNew: this.parseNumber(row[91]),  // CN: TỔNG ĐẠT NEW (for comparison testing)
          tongLoiNew: this.parseNumber(row[92]),  // CO: TỔNG LỖI NEW (for comparison testing)
        };
        
        // Tính toán các trường diff/so sánh bổ sung
        // Lấy tongDat từ hourly data (time slot cuối cùng có dữ liệu)
        const timeSlotsReverse = ['h2000', 'h1900', 'h1800', 'h1630', 'h1530', 'h1430', 'h1330', 'h1130', 'h1030', 'h930', 'h830'];
        let latestTongDat = 0;
        for (const slot of timeSlotsReverse) {
          if (record.hourlyData[slot] && record.hourlyData[slot].tongDat > 0) {
            latestTongDat = record.hourlyData[slot].tongDat;
            break;
          }
        }
        
        // Tính tongKiem và lktuiloi cho metrics (top level) - NGOÀI hourlyData
        // tongKiem = tongDat / (rft / 100)
        // Ví dụ: tongDat = 437, rft = 85.09% => tongKiem = 437 / 0.8509 = 513.4 ≈ 514
        const calculatedTongKiem = record.rft > 0 
          ? Math.round(latestTongDat / (record.rft / 100))
          : latestTongDat;
        
        // Ghi đè tongKiem (tính toán từ RFT), tongDat, lktuiloi
        record.tongKiem = calculatedTongKiem;
        record.tongDat = latestTongDat;
        record.lktuiloi = calculatedTongKiem - latestTongDat; // lktuiloi = tongKiem - tongDat
       

        // Lấy loi1-loi14 từ hourly data (time slot cuối cùng)
        let latestSlotData = null;
        for (const slot of timeSlotsReverse) {
          if (record.hourlyData[slot] && record.hourlyData[slot].tongDat > 0) {
            latestSlotData = record.hourlyData[slot];
            break;
          }
        }
        
        // Ghi đè loi1-loi14 từ hourly data (cumulative errors)
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
        
        // Tính pphThNew = tongDat / Công TH / 8
        const congTh = this.parseNumber(row[7]) || 0;
        record.pphThNew = congTh > 0 ? Math.round((latestTongDat / congTh / 8) * 100) / 100 : 0;
        record.percentagePPHNew = record.pphKh > 0 ? (record.pphThNew / record.pphKh) * 100 : 0;
        record.percentageSLTHNew = record.tongDat > 0 ? (record.tongDat / record.lkkh) * 100 : 0;

        record.diffPercentagePPHNew = record.percentagePPHNew > 0 ? record.percentagePPHNew - 100 : 0; // Diff %HT PPH New vs 100%
        record.diffPercentageSLTHNew = record.percentageSLTHNew > 0 ? record.percentageSLTHNew - 100 : 0; // Diff %SLTH New vs 100%
        
        // Tính tuiChuaTaiChe = lktuiloi - tổng lỗi (loi1-loi14)
        const totalErrors = record.loi1 + record.loi2 + record.loi3 + record.loi4 + 
                           record.loi5 + record.loi6 + record.loi7 + record.loi8 + 
                           record.loi9 + record.loi10 + record.loi11 + record.loi12 + 
                           record.loi13 + record.loi14;


         record.lktuiloiNew = totalErrors; // For comparison testing
                           
        record.tuiChuaTaiChe = record.lktuiloi - totalErrors;
        record.tuiChuaTaiCheNew = record.tongLoiNew - totalErrors; // For comparison testing
        
        record.diffLdCoMatLayout = record.ldCoMat - record.ldLayout; // 1. Diff ldCoMat vs ldLayout
        record.diffLkthTarget = record.lkth - record.targetNgay;     // 2. Diff lkth vs targetNgay  
        record.diffRftTarget = record.rft - 92;                     // 3. RFT so với 92%
        record.diffBqTargetSlcl = record.bqTargetGio - record.slcl; // 4. bqTargetGio so với slcl
        record.ratioPphThKh = record.pphKh > 0 ? record.pphTh - record.pphKh : 0; // 5. Tỷ lệ pphTh/pphKh
        record.ratioPphThKhNew = record.pphKh > 0 ? record.pphThNew - record.pphKh : 0; // 5. Tỷ lệ pphTh/pphKh
        record.diffPhanTramHt100 = record.phanTramHt - 100;         // 6. %HT so với 100%
        record.diffPhanTramHtPph100 = record.phanTramHtPph - 100;   // 7. %HT PPH so với 100%
        record.QCTarget = record.QCTarget || 0; // BO: QC TARGET

        // Tạo aliases cho compatibility với code cũ
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

      // Cache the result for 30 seconds only (real-time balance)
      this.dataCache.set(cacheKey, { data: formattedData, timestamp: Date.now() });

      return formattedData;
    } catch (error) {
      // Handle quota exceeded
      if (error.message?.includes('Quota exceeded')) {
        this.isQuotaExceeded = true;
        this.quotaResetTime = Date.now() + 60000; // Reset after 1 minute
        this.logger.error(`🚫 Google Sheets API Quota Exceeded! Using cache for 1 minute.`);
        
        // Try to return cached data if available
        const cached = this.dataCache.get(`production_${factory}`);
        if (cached) {
          this.logger.warn(`📦 Returning stale cache data (age: ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`);
          return cached.data;
        }
      }
      
      this.logger.error(`Failed to get production data for ${factory}:`, error);
      return this.getMockProductionData(factory);
    }
  }

  private parseRFTData(rftValues: any[][]): Map<string, any> {
    const rftMap = new Map<string, any>();
    
    if (!rftValues || rftValues.length === 0) {
      this.logger.warn('No RFT data available');
      return rftMap;
    }

    const dataRows = rftValues.slice(0);
    const timeSlots = ['h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000'];
    
    // Mỗi khung giờ có 18 cột: RFT (1) + Tổng kiểm (1) + Đạt lần 1 (1) + Tổng đạt (1) + 14 lỗi = 18 cột
    const COLUMNS_PER_SLOT = 18;
    
    // Khung giờ đầu tiên (8h30) bắt đầu từ cột E (index 4 trong array 0-based)
    const FIRST_SLOT_START_COL = 4;
    
    for (const row of dataRows) {
      const maChuyenLine = row[0]; // Cột A
      if (!maChuyenLine) continue;

      const hourlyErrors: any = {};
      
      for (let slotIndex = 0; slotIndex < timeSlots.length; slotIndex++) {
        const timeSlot = timeSlots[slotIndex];
        
        // Tính vị trí cột bắt đầu cho khung giờ này
        // Ví dụ: 8h30 (slot 0) = col 4, 9h30 (slot 1) = col 4 + 18 = 22, ...
        const baseCol = FIRST_SLOT_START_COL + (slotIndex * COLUMNS_PER_SLOT);
        
        // 4 cột đầu: RFT, Tổng kiểm, Đạt lần 1, Tổng đạt
        const rft = this.parsePercentage(row[baseCol]) || 0;
        const tongKiem = this.parseNumber(row[baseCol + 1]) || 0;
        const datLan1 = this.parseNumber(row[baseCol + 2]) || 0;
        const tongDat = this.parseNumber(row[baseCol + 3]) || 0;
        
        const errors: any = {
          rft,
          tongKiem,
          datLan1,
          tongDat,
        };
        
        // 14 cột tiếp theo: lỗi 1-14
        for (let i = 1; i <= 14; i++) {
          const errorColIndex = baseCol + 3 + i; // +3 để skip RFT, Tổng kiểm, Đạt lần 1, +i cho lỗi thứ i
          const errorValue = this.parseNumber(row[errorColIndex]) || 0;
          errors[`loi${i}`] = errorValue;
          errors[`errorpercentage${i}`] = tongKiem > 0 ? (errorValue / tongKiem) * 100 : 0;
        }
        
        hourlyErrors[timeSlot] = errors;
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
    
    // Get RFT from production sheet (cột BB - row[53]) - RFT tổng của cả ngày (KHÔNG thay đổi theo time slot)
    const rftFromSheet = this.parseRFT(productionRow[53]) || 0;
    
    // Get LKTUI LỖI from column BE (index 56)
    const lktuiLoi = this.parseNumber(productionRow[56]) || 0;
    
    // Get targetGio for percentageNew calculation (row[20] - column U)
    const targetGio = this.parseNumber(productionRow[20]) || 0;
    
    // Cumulative error tracking - sum từ đầu ngày đến khung giờ hiện tại
    const cumulativeErrors = {
      tongKiem: 0,
      tongKiemNew: 0, // Thêm tongKiemNew vào cumulative tracking
      datLan1: 0,
      tongDat: 0, // Thêm tongDat vào cumulative trackin
      loi1: 0, loi2: 0, loi3: 0, loi4: 0, loi5: 0, loi6: 0, loi7: 0,
      loi8: 0, loi9: 0, loi10: 0, loi11: 0, loi12: 0, loi13: 0, loi14: 0,
      tuiChuaTaiChe: 0,
    };
    
    for (let i = 0; i < timeSlots.length; i++) {
      const timeSlot = timeSlots[i];
      const sanluong = this.parseNumber(productionRow[baseProductionCol + i]) || 0;
      const percentage = this.parsePercentage(productionRow[basePercentageCol + i]) || 0;
      
      const rftErrors = rftData?.[timeSlot] || {};
      
      // Lấy giá trị tongDat của giờ hiện tại (KHÔNG cumulative)
      const currentTongDat = rftErrors.tongDat || 0;
      
      // Cộng dồn lỗi từ khung giờ hiện tại vào cumulative
      cumulativeErrors.datLan1 += rftErrors.datLan1 || 0;
      cumulativeErrors.tongDat += rftErrors.tongDat || 0; // Cộng dồn tongDat
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
      
      // Calculate tongKiem = tongDat / (RFT / 100)
      // RFT đã được lấy từ productionRow[53] ở ngoài vòng lặp - là RFT tổng của cả ngày
      // Ví dụ: tongDat = 437, rftFromSheet = 85% => tongKiem = 437 / 0.85 = 514.12 ≈ 514
      cumulativeErrors.tongKiem = rftFromSheet > 0 
        ? Math.round(cumulativeErrors.tongDat / (rftFromSheet / 100))
        : cumulativeErrors.tongDat;
      
      // Calculate cumulative error percentages
      const calculateErrorPercentage = (errorCount: number) => {
        return cumulativeErrors.tongKiem > 0 
          ? (errorCount / cumulativeErrors.tongKiem) * 100 
          : 0;
      };
      
      // Calculate lktuiloi = tongKiem - tongDat
      const lktuiloi = cumulativeErrors.tongKiem - cumulativeErrors.tongDat;
      
      // Calculate total cumulative errors (tổng tất cả lỗi từ loi1-loi14)
      const totalCumulativeErrors = 
        cumulativeErrors.loi1 + cumulativeErrors.loi2 + cumulativeErrors.loi3 + 
        cumulativeErrors.loi4 + cumulativeErrors.loi5 + cumulativeErrors.loi6 + 
        cumulativeErrors.loi7 + cumulativeErrors.loi8 + cumulativeErrors.loi9 + 
        cumulativeErrors.loi10 + cumulativeErrors.loi11 + cumulativeErrors.loi12 + 
        cumulativeErrors.loi13 + cumulativeErrors.loi14;
      
      // Calculate túi chưa tái chế = lktuiloi - tổng lỗi cumulative
      const tuiChuaTaiChe = lktuiloi - totalCumulativeErrors;
      const tuiChuaTaiCheNew = (productionRow[92] || 0) - totalCumulativeErrors; // For comparison testing
      
      // Calculate sanluongNew and percentageNew for testing
      // sanluongNew = tongDat của GIỜ HIỆN TẠI (không phải cumulative)
      const sanluongNew = currentTongDat;
      // percentageNew = tongDat của giờ hiện tại / targetGio
      const percentageNew = targetGio > 0 ? (currentTongDat / targetGio) * 100 : 0;
      
      hourlyData[timeSlot] = {
        sanluong,
        percentage,
        sanluongNew, // TEST: tongDat của giờ hiện tại (không cumulative)
        percentageNew, // TEST: (tongDat của giờ hiện tại) / targetGio
        // Cumulative RFT và tổng kiểm
        rft: rftFromSheet, // RFT tổng của cả ngày (không đổi theo time slot)
        tongKiemV2: cumulativeErrors.tongKiemNew,
        datLan1: cumulativeErrors.datLan1,
        tongDat: cumulativeErrors.tongDat,
        lktuiloi: lktuiloi, // LKTUI LỖI = tongKiem - tongDat
        // Cumulative errors (tổng từ đầu ngày đến hiện tại)
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
        // Cumulative error percentages
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
        // Túi chưa tái chế = LKTUI LỖI (BE) - tổng lỗi cumulative
        tuiChuaTaiChe: tuiChuaTaiChe,
        tuiChuaTaiCheNew: tuiChuaTaiCheNew, // For comparison testing
      };
    }
    
    return hourlyData;
  }

  private extractLineNumber(lineValue: string): string {
    // Extract number from "LINE 1" -> "1"
    const match = lineValue.match(/\d+/);
    return match ? match[0] : '1';
  }

  private extractTeamNumber(teamValue: string): string {
    // Extract number from "TỔ 1" -> "1"  
    const match = teamValue.match(/\d+/);
    return match ? match[0] : '1';
  }

  private parseRFT(value: any): number {
    // Handle #DIV/0! errors and calculate RFT percentage
    if (typeof value === 'string' && (value.includes('#DIV') || value.includes('#N/A'))) {
      return 0;
    }
    return this.parsePercentage(value);
  }

  private parsePercentage(value: any): number {
    if (typeof value === 'number') {
      // Return the exact number from Google Sheets without any modification
      return value;
    }
    
    if (typeof value === 'string') {
      // Handle European format with comma as decimal separator
      // Example: "100,079871435857%" -> 100.079871435857
      let cleaned = value.toString();
      
      // Replace comma with dot for decimal separator
      cleaned = cleaned.replace(',', '.');
      
      // Remove % symbol and other non-numeric characters except decimal point and minus sign
      cleaned = cleaned.replace(/[^0-9.-]/g, '');
      
      const parsed = parseFloat(cleaned);
      
      if (isNaN(parsed)) return 0;
      
      // Return the exact parsed value without any conversion
      return parsed;
    }
    
    return 0;
  }

  private parseNumber(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      // Remove any non-numeric characters except decimal point and minus sign
      const cleaned = value.replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  private getMockProductionData(factory: string): any[] {
    return [
      {
        id: 0,
        factory,
        maChuyenLine: `${factory}-L1`,
        nhaMay: factory,
        line: '1',
        to: '1',
        team: '1',
        maHang: 'FCDB98',
        slth: 128,
        actual_quantity: 128,
        congKh: 110,
        planned_work: 110,
        congTh: 110,
        actual_work: 110,
        pphKh: 102,
        planned_pph: 102,
        pphThien: 103,
        actual_pph: 103,
        hitPPH: 101,
        targetNgay: 522,
        daily_target: 522,
        targetGio: 55,
        hourly_target: 55,
        lkth: 110,
        cumulative_actual: 110,
        hitSLTH: 67,
        timestamps: {
          '8h30': 55,
          '9h30': 55,
          '10h30': 0,
          '11h30': 0
        }
      }
    ];
  }

}