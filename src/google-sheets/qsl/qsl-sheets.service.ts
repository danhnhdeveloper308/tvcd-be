import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleSheetsService } from '../google-sheets.service';

/**
 * QSL Sheets Service (QUAI, SƠN, LÓT)
 * Đọc dữ liệu từ sheets LINE1, LINE2, LINE3, LINE4...
 * Range: A1:T90
 *
 * Sheet Structure:
 * - A: TÊN TỔ (TỔ 1, TỔ 2, hoặc trống nếu là dòng TÚI NHỎ)
 * - B: TGLV (Thời gian làm việc - số nhóm, HOẶC "TÚI NHỎ (NẾU CÓ)")
 * - C: NHÓM (Tên nhóm: ĐỒNG GÓI, QC KIỂM TÚI, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP)
 * - D: LĐ LAYOUT (Lao động layout)
 * - E: THỰC TẾ (Lao động thực tế)
 * - F: KẾ HOẠCH (Kế hoạch sản xuất)
 * - G-Q: 8H30, 9H30, 10H30, 11H30, 13H30, 14H30, 15H30, 16H30, 18H, 19H, 20H (Hourly data)
 * - R: LUỸ KẾ THỰC HIỆN
 * - S: LUỸ KẾ KẾ HOẠCH
 * - T: %HT (Phần trăm hoàn thành)
 *
 * Logic:
 * - Mỗi tổ có tối đa 17 dòng:
 *   + 9 dòng cố định (ĐÓNG GÓI, QC KIỂM TÚI, SƠN TP, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP) - Luôn có
 *   + 8 dòng TÚI NHỎ (nếu có): QC KIỂM TÚI, SƠN TP, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP (không có ĐÓNG GÓI)
 *   + TÚI NHỎ section bắt đầu khi: Cột A hoặc Cột B chứa "TÚI NHỎ" / "TÚI NHỎ(NẾU CÓ)"
 *   + Tất cả rows sau marker "TÚI NHỎ" (cho đến TỔ mới) đều thuộc tuiNhoGroups
 *   + Chỉ return rows có Kế hoạch (F) > 0
 */
@Injectable()
export class QSLSheetsService {
  private readonly logger = new Logger(QSLSheetsService.name);

  // In-memory cache
  private dataCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 15000; // 15 seconds cache

  // Fixed groups for each team (9 rows)
  private readonly FIXED_GROUPS = [
    'ĐÓNG GÓI',
    'QC KIỂM TÚI',
    'SƠN TP',
    'RÁP',
    'THÂN',
    'LÓT',
    'QC KIỂM QUAI',
    'QUAI',
    'SƠN CT/BTP',
  ];

  constructor(
    private googleSheetsService: GoogleSheetsService,
    private configService: ConfigService,
  ) {
    this.logger.log('✅ QSL: Service initialized (using shared GoogleSheetsService)');
  }

  /**
   * Get production data by line number (1, 2, 3, 4...)
   * Returns data grouped by TỔ (Team)
   *
   * @param line - Line number (1, 2, 3, 4...)
   * @returns Grouped data by team
   */
  async getProductionDataByLine(line: number): Promise<any> {
    try {
      const sheetName = `LINE${line}`;
      const cacheKey = `qsl-line${line}`;

      // Check cache
      const cached = this.dataCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        this.logger.debug(`💾 QSL: Cache hit for ${sheetName}`);
        return cached.data;
      }

      // Fetch from Google Sheets using shared service
      this.logger.log(`📊 QSL: Fetching data for ${sheetName}`);

      // Check if QSL has custom spreadsheet ID
      const qslSheetId = this.configService.get<string>('QSL_SHEET_ID');
      const defaultSheetId = this.configService.get<string>('GOOGLE_SHEET_ID');
      const spreadsheetId = qslSheetId || defaultSheetId;

      let dataRows: any[][];
      
      if (qslSheetId) {
        this.logger.debug(`📄 QSL: Using custom spreadsheet ID: ${qslSheetId.substring(0, 10)}...`);
        dataRows = await this.googleSheetsService.getSheetDataWithCustomId(sheetName, qslSheetId, 'A1:T90');
      } else {
        dataRows = await this.googleSheetsService.getSheetData(sheetName, 'A1:T90');
      }

      if (!dataRows || dataRows.length === 0) {
        this.logger.warn(`⚠️ QSL: No data found for ${sheetName}`);
        return this.getEmptyResponse(line);
      }

      // Parse and group data by team
      const parsedData = this.parseGroupedData(dataRows, line);

      // Cache the result
      this.dataCache.set(cacheKey, {
        data: parsedData,
        timestamp: Date.now(),
      });

      this.logger.log(`✅ QSL: Data fetched for ${sheetName} (${parsedData.totalTeams} teams)`);

      return parsedData;
    } catch (error) {
      this.logger.error(`❌ Failed to get QSL data for LINE${line}:`, error.message);
      throw error;
    }
  }

  /**
   * Parse data and group by TỔ (Team)
   * Each team contains:
   * - 9 fixed rows (ĐỒNG GÓI, QC KIỂM TÚI, SƠN TP, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP)
   * - Up to 8 TÚI NHỎ rows (QC KIỂM TÚI, SƠN TP, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP) if Kế hoạch > 0
   */
  private parseGroupedData(dataRows: any[][], line: number): any {
    const teams: any[] = [];
    let currentTeam: any = null;
    let fixedRowCount = 0;
    let inTuiNhoSection = false; // ⭐ Track if we're in TÚI NHỎ section

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];

      // Column A: TÊN TỔ
      const tenTo = (row[0] || '').toString().trim();
      const tglvRaw = (row[1] || '').toString().trim(); // Column B: TGLV (can also contain "TÚI NHỎ")
      const tglv = this.parseNumber(row[1]); // Column B: TGLV as number
      const nhom = (row[2] || '').toString().trim(); // Column C: NHÓM

      // Detect new team (TỔ 1, TỔ 2, etc.)
      if (tenTo.match(/^TỔ\s+\d+$/i)) {
        // Save previous team if exists
        if (currentTeam) {
          teams.push(currentTeam);
        }

        // Start new team
        currentTeam = {
          tenTo: tenTo,
          tglv: tglv,
          fixedGroups: [], // 9 fixed rows (ĐÓNG GÓI, QC KIỂM TÚI, SƠN TP, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP)
          tuiNhoGroups: [], // TÚI NHỎ rows (if any)
        };
        fixedRowCount = 0;
        inTuiNhoSection = false; // ⭐ Reset TÚI NHỎ section flag
        
        // ✅ FIX: Don't skip this row! The first row contains team info AND first group data
        // Parse this row's data (Column C onwards contains ĐÓNG GÓI data)
        if (nhom) {
          const rowData = this.parseRowData(row, nhom);
          currentTeam.fixedGroups.push(rowData);
          fixedRowCount++;
        }
        continue;
      }

      // Check if this row starts "TÚI NHỎ" section
      // ⭐ "TÚI NHỎ" có thể nằm ở cột A (tenTo) HOẶC cột B (tglvRaw)
      const isTuiNhoMarker = tenTo.match(/^TÚI\s+NHỎ/i) || tglvRaw.match(/^TÚI\s+NHỎ/i);
      
      if (isTuiNhoMarker) {
        // Enter TÚI NHỎ section
        inTuiNhoSection = true;
        this.logger.debug(`🔍 Entering TÚI NHỎ section: Cột A="${tenTo}" | Cột B="${tglvRaw}"`);
      }

      // Parse row data (skip if no nhom)
      if (!nhom) {
        continue;
      }
      
      const rowData = this.parseRowData(row, nhom);

      // Assign to current team
      if (currentTeam) {
        if (!inTuiNhoSection && fixedRowCount < this.FIXED_GROUPS.length) {
          // ⭐ Add to fixed groups (9 rows: ĐÓNG GÓI, QC KIỂM TÚI, SƠN TP, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP)
          currentTeam.fixedGroups.push(rowData);
          fixedRowCount++;
        } else if (inTuiNhoSection) {
          // ⭐ Add to TÚI NHỎ groups (all rows after "TÚI NHỎ" marker, only if Kế hoạch > 0)
          const keHoach = this.parseNumber(row[5]); // Column F: KẾ HOẠCH
          if (keHoach > 0) {
            currentTeam.tuiNhoGroups.push(rowData);
            this.logger.debug(`  ➕ Added to tuiNhoGroups: ${nhom} (Kế hoạch: ${keHoach})`);
          } else {
            this.logger.debug(`  ⏭️  Skipped tuiNhoGroups: ${nhom} (Kế hoạch: ${keHoach} <= 0)`);
          }
        }
      }
    }

    // Save last team
    if (currentTeam) {
      teams.push(currentTeam);
    }

    return {
      line: line,
      sheetName: `LINE${line}`,
      totalTeams: teams.length,
      teams: teams,
      lastUpdate: new Date().toISOString(),
    };
  }

  /**
   * Parse a single row data
   */
  private parseRowData(row: any[], nhom: string): any {
    return {
      nhom: nhom, // Column C: NHÓM
      ldLayout: this.parseNumber(row[3]), // Column D: LĐ LAYOUT
      thucTe: this.parseNumber(row[4]), // Column E: THỰC TẾ
      keHoach: this.parseNumber(row[5]), // Column F: KẾ HOẠCH
      hourly: {
        h8h30: this.parseNumber(row[6]), // Column G
        h9h30: this.parseNumber(row[7]), // Column H
        h10h30: this.parseNumber(row[8]), // Column I
        h11h30: this.parseNumber(row[9]), // Column J
        h13h30: this.parseNumber(row[10]), // Column K
        h14h30: this.parseNumber(row[11]), // Column L
        h15h30: this.parseNumber(row[12]), // Column M
        h16h30: this.parseNumber(row[13]), // Column N
        h18h: this.parseNumber(row[14]), // Column O
        h19h: this.parseNumber(row[15]), // Column P
        h20h: this.parseNumber(row[16]), // Column Q
      },
      luyKeThucHien: this.parseNumber(row[17]), // Column R
      luyKeKeHoach: this.parseNumber(row[18]), // Column S
      percentHT: this.parsePercentage(row[19]), // Column T: %HT
    };
  }

  /**
   * Parse percentage value
   */
  private parsePercentage(value: any): number {
    if (typeof value === 'number') {
      return Math.round(value * 100); // Convert 0.86 -> 86
    }
    if (typeof value === 'string') {
      // Handle "86%", "0.86", "86"
      const cleanValue = value.replace('%', '').trim();
      const num = parseFloat(cleanValue);
      if (!isNaN(num)) {
        return num > 1 ? Math.round(num) : Math.round(num * 100);
      }
    }
    return 0;
  }

  /**
   * Parse number value
   */
  private parseNumber(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const num = parseFloat(value.replace(/,/g, ''));
      return isNaN(num) ? 0 : num;
    }
    return 0;
  }

  /**
   * Get empty response structure
   */
  private getEmptyResponse(line: number): any {
    return {
      line: line,
      sheetName: `LINE${line}`,
      totalTeams: 0,
      teams: [],
      lastUpdate: new Date().toISOString(),
    };
  }

  /**
   * Clear cache for specific line or all lines
   */
  clearCache(line?: number) {
    if (line) {
      const cacheKey = `qsl-line${line}`;
      this.dataCache.delete(cacheKey);
      this.logger.log(`🗑️ QSL: Cache cleared for LINE${line}`);
    } else {
      this.dataCache.clear();
      this.logger.log('🗑️ QSL: All cache cleared');
    }
  }
}
