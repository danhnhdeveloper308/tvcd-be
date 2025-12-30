import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

@Injectable()
export class CDSheetsService {
  private readonly logger = new Logger(CDSheetsService.name);
  private sheets: any;

  // In-memory cache
  private dataCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 15000; // 15 seconds - Reduced from 30s for faster updates

  // Quota management
  private isQuotaExceeded = false;
  private quotaResetTime = 0;

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
      this.logger.error('Failed to initialize Google Sheets API for CD:', error);
      this.sheets = null;
    }
  }

  private async testConnection() {
    try {
      const sheetId = this.configService.get<string>('GOOGLE_SHEET_ID');
      if (sheetId && this.sheets) {
        await this.sheets.spreadsheets.get({
          spreadsheetId: sheetId,
          fields: 'properties.title',
        });
      }
    } catch (error) {
      this.logger.warn('Google Sheets connection test failed for CD:', error.message);
    }
  }

  // Request throttling
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 100; // 100ms between requests

  /**
   * Get sheet data for CD line with retry logic
   * Sheet names: DATA_CD and DATA_RFT_CD
   */
  async getSheetData(sheetName: string, range?: string): Promise<any[][]> {
    try {
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID');

      // Use default range from ENV if not provided
      if (!range) {
        range = this.configService.get<string>('CD_DATA_RANGE') || 'A1:AX15';
      }

      // ✅ Retry with exponential backoff on quota errors
      const maxRetries = 3;
      let lastError: any;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // ✅ Throttle requests
          await this.throttleRequest();

          const response = await this.sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!${range}`,
          });

          return response.data.values || [];
        } catch (error) {
          lastError = error;

          if (error.message?.includes('Quota exceeded')) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            this.logger.warn(
              `⏳ CD: Quota exceeded for ${sheetName}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`,
            );

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
      this.logger.error(`❌ CD: Failed to fetch data from sheet ${sheetName}:`, error);
      return [];
    }
  }

  /**
   * ✅ Throttle API requests to avoid burst calls
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

  /**
   * Get production lines list for CD
   * Read from DATA_CD sheet (A1:AX15)
   */
  async getProductionLinesList(): Promise<
    Array<{
      code: string;
      nhaMay: string;
      line: string;
      to: string;
      percentageHT: string;
      rft: string;
    }>
  > {
    try {
      // Get range from ENV or use default
      const cdDataRange = this.configService.get<string>('CD_DATA_RANGE') || 'A1:BF100';
      const values = await this.getSheetData('DATA_CD', cdDataRange);

      if (values.length <= 1) {
        this.logger.warn(`CD: No data found in DATA_CD sheet`);
        return [];
      }

      const data = values.slice(1);
      const linesSet = new Set<string>();

      const linesList = data
        .map(row => {
          const code = (row[0] || '').toString().trim(); // Column A: Mã chuyền
          const nhaMay = (row[1] || '').toString().trim(); // Column B: Nhà máy
          const line = (row[2] || '').toString().trim(); // Column C: Line
          const to = (row[3] || '').toString().trim(); // Column D: Tổ
          const percentageHT = row[22]; // Column W: %HT
          const rft = ''; // No RFT in new structure

          // Filter CD lines (KVHB07CD format)
          if (code === '' || !code.startsWith('KVHB07CD')) {
            return null;
          }

          const uniqueKey = `${code}`;
          if (!linesSet.has(uniqueKey)) {
            linesSet.add(uniqueKey);
            return { code, nhaMay, line, to, percentageHT, rft };
          }
          return null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => a.code.localeCompare(b.code));

      return linesList;
    } catch (error) {
      this.logger.error(`❌ CD: Error fetching production lines list:`, error);
      return [
        {
          code: 'KVHB07CD27',
          nhaMay: 'TS3',
          line: 'LINE CD27',
          to: 'TỔ 1',
          percentageHT: '',
          rft: '',
        },
      ];
    }
  }

  /**
   * Get production data for CD lines
   * Read from DATA_CD (A-BB) - CD as parent row + Tổ as subrows
   */
  async getProductionData(factory: string): Promise<any[]> {
    try {
      if (this.isQuotaExceeded && Date.now() < this.quotaResetTime) {
        this.logger.warn(`⚠️ CD: Quota exceeded, using cache`);
        const cached = this.dataCache.get(`cd_production_${factory}`);
        if (cached) return cached.data;
        return [];
      }

      const cacheKey = `cd_production_${factory}`;
      const cached = this.dataCache.get(cacheKey);
      const now = Date.now();

      if (cached && now - cached.timestamp < this.CACHE_TTL) {
        return cached.data;
      }

      // Get range from ENV or use default
      const cdDataRange = this.configService.get<string>('CD_DATA_RANGE') || 'A1:BF200';
      const serverFactory = this.configService.get<string>('SERVER_FACTORY') || 'ALL';

      this.logger.log(
        `📊 CD: Fetching data for factory=${factory}, serverFactory=${serverFactory}, dataRange=${cdDataRange}`,
      );

      const productionValues = await this.getSheetData('DATA_CD', cdDataRange);

      if (productionValues.length <= 1) {
        this.logger.warn(`CD: No data found in DATA_CD sheet`);
        return [];
      }

      const data = productionValues.slice(1);

      // Line code mapping (for detecting parent rows)
      const factoryLineCodeMap: { [key: string]: string[] } = {
        TS1: ['KVHB07CD16', 'KVHB07CD17', 'KVHB07CD18', 'KVHB07CD19'],
        TS2: ['KVHB07CD20', 'KVHB07CD21', 'KVHB07CD22', 'KVHB07CD23'],
        TS3: ['KVHB07CD24', 'KVHB07CD25', 'KVHB07CD26', 'KVHB07CD27'],
      };

      // Determine target factories
      let targetFactories: string[] = [];
      if (factory === 'ALL') {
        targetFactories = ['TS1', 'TS2', 'TS3'];
      } else {
        targetFactories = [factory.toUpperCase()];
      }

      // Collect all target line codes
      let targetLineCodes: string[] = [];
      for (const f of targetFactories) {
        const codes = factoryLineCodeMap[f] || [];
        targetLineCodes.push(...codes);
      }

      if (targetLineCodes.length === 0) {
        this.logger.warn(`CD: No line codes found for factory ${factory}`);
        return [];
      }

      // ✅ FIXED ROW COUNT PER LINE (cố định trên Sheet)
      const lineRowCount: { [key: string]: number } = {
        // TS1 - LINE 1 & 2: 11 rows (1 parent + 10 subRows)
        KVHB07CD16: 11,
        KVHB07CD17: 11,
        KVHB07CD18: 5,
        KVHB07CD19: 5,

        // TS2 - All 5 rows
        KVHB07CD20: 5,
        KVHB07CD21: 5,
        KVHB07CD22: 5,
        KVHB07CD23: 5,

        // TS3 - LINE 1 & 2: 11 rows (1 parent + 10 subRows)
        KVHB07CD24: 11,
        KVHB07CD25: 11,
        KVHB07CD26: 5,
        KVHB07CD27: 5,
      };

      // ✅ ULTRA-SIMPLE: Collect EXACT number of rows per line
      const cdGroups = new Map<
        string,
        {
          parentRow: any;
          teamRows: any[];
          canBoQuanLy: string;
        }
      >();

      let i = 0;

      while (i < data.length) {
        const row = data[i];
        const code = (row[0] || '').toString().trim();
        const nhaMay = (row[1] || '').toString().trim();
        const lineField = (row[2] || '').toString().trim();

        // ✅ DETECT PARENT ROW
        if (
          code !== '' &&
          lineField &&
          lineField.startsWith('LINE') &&
          targetLineCodes.includes(code)
        ) {
          // Get canBoQuanLy from next row
          let canBoQuanLy = '';
          if (i + 1 < data.length) {
            const nextRow = data[i + 1];
            const nextCode = (nextRow[0] || '').toString().trim();
            const nextLine = (nextRow[2] || '').toString().trim();

            if (nextCode === '' && nextLine && !nextLine.startsWith('LINE')) {
              canBoQuanLy = nextLine;
            }
          }

          // ✅ Get fixed row count for this line
          const totalRows = lineRowCount[code] || 5; // Default to 5
          const subRowCount = totalRows - 1; // Exclude parent

          // ✅ Collect EXACT number of subRows
          const teamRows: any[] = [];
          for (let j = 1; j <= subRowCount && i + j < data.length; j++) {
            const subRow = data[i + j];
            const subCode = (subRow[0] || '').toString().trim();

            // Stop if we hit next parent
            if (subCode !== '' && subCode.startsWith('KVHB07CD')) {
              this.logger.warn(
                `⚠️ Hit next parent early at row ${i + j}, expected ${subRowCount} but got ${j - 1}`,
              );
              break;
            }

            teamRows.push(subRow);

            const maHang = (subRow[4] || '').toString().trim();
            const toField = (subRow[3] || '').toString().trim();
          }

          cdGroups.set(code, {
            parentRow: row,
            teamRows: teamRows,
            canBoQuanLy: canBoQuanLy,
          });

          // ✅ Skip to next parent (jump over all subRows)
          i += totalRows;
        } else {
          i++; // Move to next row
        }
      }

      // ✅ Log verification
      for (const [cdCode, group] of cdGroups.entries()) {
        const expected = (lineRowCount[cdCode] || 5) - 1;
        const actual = group.teamRows.length;
        const status = actual === expected ? '✅' : '❌';

        if (actual !== expected) {
          this.logger.error(
            `❌ MISMATCH: ${cdCode} expected ${expected} but got ${actual} subRows!`,
          );
        }
      }

      // ✅ Format data WITHOUT any filtering
      const formattedData: any[] = [];

      for (const [cdCode, group] of cdGroups.entries()) {
        const mainRow = group.parentRow;
        const subRows = group.teamRows;

        // Get grouping rule
        const lineKey = `${mainRow[1]}-${cdCode.replace('KVHB07', '')}`.toUpperCase();
        const groupRule = this.getGroupingRules()[lineKey] || null;

        const workingDaysPerMonth = 25;
        const khGiaoThang = this.parseNumber(mainRow[38]) || 0;
        const khBqNgay = khGiaoThang > 0 ? Math.round(khGiaoThang / workingDaysPerMonth) : 0;

        // ✅ Parse main row (unchanged)
        const lineData = {
          id: formattedData.length,
          maChuyen: mainRow[0] || '',
          maChuyenLine: mainRow[0] || '',
          nhaMay: mainRow[1] || '',
          line: mainRow[2] || '',
          canBoQuanLy: group.canBoQuanLy,
          to: mainRow[3] || '',
          maHang: mainRow[4] || '',
          slth: this.parseNumber(mainRow[5]),
          congKh: this.parseNumber(mainRow[6]),
          congTh: this.parseNumber(mainRow[7]),
          pphKh: this.parseNumber(mainRow[8]),
          pphTh: this.parseNumber(mainRow[9]),
          phanTramHtPph: this.parseNumber(mainRow[10]),
          gioSx: this.parseNumber(mainRow[11]),
          ldCoMat: this.parseNumber(mainRow[12]),
          ldLayout: this.parseNumber(mainRow[13]),
          ldHienCo: this.parseNumber(mainRow[14]),
          nangSuat: this.parseNumber(mainRow[15]),
          pphTarget: this.parseNumber(mainRow[16]),
          pphGiao: this.parseNumber(mainRow[17]),
          phanTramGiao: this.parseNumber(mainRow[18]),
          targetNgay: this.parseNumber(mainRow[19]),
          targetGio: this.parseNumber(mainRow[20]),
          lkth: this.parseNumber(mainRow[21]),
          phanTramHt: this.parsePercentage(mainRow[22]),

          // Hourly data (X-AH: index 23-33)
          hourlyData: this.buildHourlyDataCDSimple(mainRow),

          // Additional CD fields (AI-AS: index 34-44)
          lean: mainRow[34] || '',
          phanTram100: this.parseNumber(mainRow[35]),
          image: mainRow[36] || '',
          lkkh: this.parseNumber(mainRow[37]),
          khGiaoThang: this.parseNumber(mainRow[38]),
          khbqGQ: this.parseNumber(mainRow[39]),
          slkh_bqlk: this.parseNumber(mainRow[40]),
          slthThang: this.parseNumber(mainRow[41]),
          phanTramThang: this.parseNumber(mainRow[42]),
          conlai: this.parseNumber(mainRow[43]),
          bqCansxNgay: this.parseNumber(mainRow[44]),
          tglv: this.parseNumber(mainRow[45]) || 0,
          ncdv: this.parseNumber(mainRow[46]) || 0,
          dbcu: this.parseNumber(mainRow[47]) || 0,
          phanTramDapUng: this.parsePercentage(mainRow[48]) || 0,
          tonMay: this.parseNumber(mainRow[49]) || 0,
          nc1ntt: this.parseNumber(mainRow[50]) || 0,
          nc2ntt: this.parseNumber(mainRow[51]) || 0,
          nc3ntt: this.parseNumber(mainRow[52]) || 0,
          note: mainRow[53] || '',
          db1ntt: this.parseNumber(mainRow[54]) || 0,
          db2ntt: this.parseNumber(mainRow[55]) || 0,
          db3ntt: this.parseNumber(mainRow[56]) || 0,
          dbNgay: this.parseNumber(mainRow[57]) || 0,

          // ✅ NEW: Monthly Planning Data for Section 1 (Frontend mapping)
          monthlyPlanData: {
            cd: mainRow[2] || '', // LINE CD16 → Display as "CD1", "CD2", etc. (frontend will format)
            khGiaoThang: this.parseNumber(mainRow[38]) || 0, // AI: KH GIAO THÁNG
            khBqNgay: khBqNgay, // Calculated: khGiaoThang / 25
            slkhBq: this.parseNumber(mainRow[40]) || 0, // AK: SLKH BQ
            slthThang: this.parseNumber(mainRow[41]) || 0, // AO: SLTH THÁNG
            phanTramThang: this.parseNumber(mainRow[42]) || 0, // AP: %THÁNG
            clThang: this.parseNumber(mainRow[43]) || 0, // AQ: CÒN LẠI (chênh lệch)
            bqCanSxNgay: this.parseNumber(mainRow[44]) || 0, // AR: BQ CẦN SX NGÀY
            tglv: this.parseNumber(mainRow[45]) || 0, // AT: TGLV (for reference)
          },

          // Sub-rows data (Product/SKU-level data)
          // 📌 IMPORTANT: Each subrow = 1 product (SKU) for 1 team
          // One team can have MULTIPLE subrows (multiple SKUs)
          //
          // Google Sheet Structure:
          // Row 1: Tổ 3 | CCC30-B4YTH    ← First SKU (toField has value)
          // Row 2: ""   | CEB53-B4/AY    ← Second SKU of Tổ 3 (toField empty, inherit from previous)
          // Row 3: Tổ 4 | CP149-B4DVT    ← New team, First SKU
          //
          // Filter criteria: tonMay > 0 (Mã hàng already checked during row collection)
          subRows: subRows.map((subRow, idx) => {
            const toField = (subRow[3] || '').toString().trim();

            // Inherit `to` from previous row if empty
            let currentTo = toField;
            if (toField === '' && idx > 0) {
              for (let i = idx - 1; i >= 0; i--) {
                const prevToField = (subRows[i][3] || '').toString().trim();
                if (prevToField !== '') {
                  currentTo = prevToField;
                  break;
                }
              }
            }

            const tonMay = this.parseNumber(subRow[49]) || 0;
            const targetGio = this.parseNumber(subRow[20]) || 0;
            const ngayTon = targetGio > 0 && tonMay > 0 ? (tonMay / targetGio).toFixed(1) : '';

            // ⭐ Return ALL rows - Frontend will handle filtering
            return {
              tglv: this.parseNumber(subRow[45]) || 0,
              to: currentTo.replace(/TỔ\s*/i, ''),
              maHang: subRow[4] || '',

              // ✅ NEW: Columns H-N (index 7-13)
              nhuCauLuyKe: this.parseNumber(subRow[7]) || 0, // H: Nhu cầu luỹ kê
              tenChiTiet: subRow[8] || '', // I: Tên chi tiết
              keHoachGiao: this.parseNumber(subRow[9]) || 0, // J: Kế hoạch giao
              luyKeGiao: this.parseNumber(subRow[10]) || 0, // K: Luỹ kê giao
              conLai: this.parseNumber(subRow[11]) || 0, // L: Còn lại
              ttdb: subRow[12] || '', // M: TTĐB
              canXuLy: this.parseNumber(subRow[13]) || 0, // N: Cần xử lý

              targetNgay: this.parseNumber(subRow[19]) || 0,
              targetGio: targetGio,
              lkkh: this.parseNumber(subRow[37]) || 0,
              lkth: this.parseNumber(subRow[21]) || 0,
              ncdv: this.parseNumber(subRow[46]) || 0,
              dbcu: this.parseNumber(subRow[47]) || 0,
              phanTramDapUng: this.parsePercentage(subRow[48]) || 0,
              tonMay: tonMay,
              ngayTon: ngayTon,
              nc1ntt: this.parseNumber(subRow[50]) || 0,
              nc2ntt: this.parseNumber(subRow[51]) || 0,
              nc3ntt: this.parseNumber(subRow[52]) || 0,
              note: subRow[53] || '',
              db1ntt: this.parseNumber(subRow[54]) || 0,
              db2ntt: this.parseNumber(subRow[55]) || 0,
              db3ntt: this.parseNumber(subRow[56]) || 0,
              dbNgay: this.parseNumber(subRow[57]) || 0,
            };
          }),

          groupingRule: groupRule,

          // ✅ Calculate totals from ALL subRows (no filtering)
          ncdvTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[46]), 0),
          dbcuTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[47]), 0),
          tonMayTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[49]), 0),
          nc1nttTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[50]), 0),
          nc2nttTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[51]), 0),
          nc3nttTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[52]), 0),
          db1nttTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[54]), 0),
          db2nttTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[55]), 0),
          db3nttTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[56]), 0),
          dbNgayTotal: subRows.reduce((sum, sr) => sum + this.parseNumber(sr[57]), 0),

          diffLdCoMatLayout: this.parseNumber(mainRow[12]) - this.parseNumber(mainRow[13]),
        };

        formattedData.push(lineData);
      }

      // Cache the result
      this.dataCache.set(cacheKey, { data: formattedData, timestamp: Date.now() });

      return formattedData;
    } catch (error) {
      if (error.message?.includes('Quota exceeded')) {
        this.isQuotaExceeded = true;
        this.quotaResetTime = Date.now() + 60000;
      }

      this.logger.error(`CD: Failed to get production data:`, error);
      return [];
    }
  }

  /**
   * Get grouping rules for sub-rows display
   * Returns grouping configuration per factory-line
   *
   * Format: { "TS1-CD16": [[1,2]] } means:
   * - Group T1+T2 together
   * - Remaining teams (T3, T4, T5...) will be auto-grouped to max 2 rows by frontend
   *
   * Logic:
   * 1. Apply groupingRule first (e.g., T1+T2)
   * 2. Group remaining teams automatically (e.g., T3+T4+T5 if total > 2 rows)
   *
   * Note: Team numbers are actual TGLV values from AT column (index 45), NOT index-based
   */
  private getGroupingRules(): { [key: string]: number[][] | null } {
    return {
      // TS1 grouping (14 teams total: T1-T14)
      'TS1-CD16': [[1, 2]], // CD1: Group T1+T2, remaining teams auto-grouped (e.g., T3+T4+T5)
      'TS1-CD17': [
        [6, 8],
        [7, 9],
      ], // CD2: Group T6+T8, T7+T9, remaining auto-grouped
      'TS1-CD18': null,
      'TS1-CD19': null,

      // TS2 grouping (8 teams total: T1-T8)
      'TS2-CD20': null,
      'TS2-CD21': null,
      'TS2-CD22': null,
      'TS2-CD23': null,

      // TS3 grouping (13 teams total: T1-T14 skip T9)
      'TS3-CD24': null, // CD1: No grouping (T1, T2, T3, T4, T5 → auto-grouped if >2)
      'TS3-CD25': [
        [7, 8],
        [10, 6],
      ], // CD2: T7+T8, T10+T6 (4 tổ: 6,7,8,10 - bỏ tổ 9)
      'TS3-CD26': null, // CD3: No grouping (T11, T12)
      'TS3-CD27': null, // CD4: No grouping (T13, T14)
    };
  }

  /**
   * Build hourly data for CD lines - New simplified structure
   * X-AH (index 23-33): Sản lượng từng khung giờ (8H30→20H00)
   * Calculate percentage: sanluong / targetGio * 100
   */
  private buildHourlyDataCDSimple(productionRow: any[]): any {
    const timeSlots = [
      'h830',
      'h930',
      'h1030',
      'h1130',
      'h1330',
      'h1430',
      'h1530',
      'h1630',
      'h1800',
      'h1900',
      'h2000',
    ];
    const hourlyData: any = { hourly: {}, total: 0, latest: { hour: 'h830', value: 0 } };

    // X-AH: Sản lượng (index 23-33)
    const baseSanluongCol = 23; // X: 8H30 starts at index 23

    // U: targetGio (index 20) - used for percentage calculation
    const targetGio = this.parseNumber(productionRow[20]) || 0;

    for (let i = 0; i < timeSlots.length; i++) {
      const timeSlot = timeSlots[i];
      const sanluong = this.parseNumber(productionRow[baseSanluongCol + i]) || 0;

      // Calculate percentage: sanluong / targetGio * 100
      let percentage = 0;
      if (targetGio > 0 && sanluong > 0) {
        percentage = (sanluong / targetGio) * 100;
      }

      hourlyData.hourly[timeSlot] = {
        sanluong,
        percentage: Math.round(percentage * 100) / 100, // Round to 2 decimals
      };
    }

    return hourlyData;
  }

  private extractLineNumber(lineValue: string): string {
    const match = lineValue.match(/\d+/);
    return match ? match[0] : '1';
  }

  private extractTeamNumber(teamValue: string): string {
    const match = teamValue.match(/\d+/);
    return match ? match[0] : '1';
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

  private extractTeam(teamValue: string): string {
    // Current valure is like "TỔ 1" or "TỔ 1 + 3"
    const match = teamValue.match(/TỔ\s*(\d+)(\s*\+\s*(\d+))?/i);
    if (match) {
      if (match[3]) {
        return `${match[1]}+${match[3]}`;
      }
      return match[1];
    }
    return '';
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

  private parseRFT(value: any): number {
    if (typeof value === 'string' && (value.includes('#DIV') || value.includes('#N/A'))) {
      return 0;
    }
    return this.parsePercentage(value);
  }

  /**
   * ✅ NEW: Check if current position is a next parent row
   */
  private isNextParentRow(data: any[][], currentIndex: number): boolean {
    // Look ahead ONLY 1 row (immediate next)
    if (currentIndex + 1 >= data.length) {
      return false; // No more rows
    }

    const nextRow = data[currentIndex + 1];
    const nextCode = (nextRow[0] || '').toString().trim();
    const nextLineField = (nextRow[2] || '').toString().trim();

    // Parent row MUST have BOTH: code in A AND "LINE" in C
    const isParent = nextCode !== '' && nextLineField && nextLineField.startsWith('LINE');

    // if (isParent) {
    //   this.logger.debug(`  🔍 Next row at ${currentIndex + 1} is parent: code="${nextCode}", line="${nextLineField}"`);
    // }

    return isParent;
  }

  /**
   * ✅ IMPROVED: Check if row has production data
   * Return TRUE if row has ANY meaningful production data
   */
  private hasProductionDataImproved(row: any[]): boolean {
    // ✅ CRITICAL: Check AX (tonMay) FIRST - most important indicator
    const tonMay = this.parseNumber(row[49]); // AX: TỒN MAY
    if (tonMay > 0) {
      return true; // If has inventory, definitely a valid subRow
    }

    // ✅ Check other production metrics
    const productionMetrics = [
      this.parseNumber(row[19]), // T: TARGET NGÀY
      this.parseNumber(row[20]), // U: TARGET GIỜ
      this.parseNumber(row[21]), // V: LKTH
      this.parseNumber(row[37]), // AL: LKKH
      this.parseNumber(row[46]), // AU: NCĐV
      this.parseNumber(row[47]), // AV: ĐBCỨ
    ];

    // Return TRUE if ANY metric > 0
    return productionMetrics.some(value => value > 0);
  }

  /**
   * ✅ DEPRECATED: Old method - replaced by hasProductionDataImproved
   */
  private hasProductionData(row: any[]): boolean {
    // Keep for backward compatibility but use new method
    return this.hasProductionDataImproved(row);
  }
}
