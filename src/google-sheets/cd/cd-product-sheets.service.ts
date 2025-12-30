import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

/**
 * CD Product Sheets Service - NEW FORMAT
 * Đọc dữ liệu từ 4 sheets (CD1, CD2, CD3, CD4)
 * Group theo cột E (MÃ HÀNG)
 *
 * Sheet Structure:
 * - A: MÃ CHUYỀN (KVHB07CD27)
 * - B: NHÀ MÁY (TS3)
 * - C: LINE (13+14)
 * - D: TỔ (empty for products)
 * - E: MÃ (CEM07, CEN91...)
 * - F: MẪU (B4Z5D, B4Z38...)
 * - G: SLKH (5341, 6739...)
 * - H: NHU CẦU LŨY KẾ (2110)
 * - I: TÊN CHI TIẾT (Thân, Hồng túi, QX dưới không...)
 * - J: KẾ HOẠCH GIAO (0, 4400...)
 * - K: LŨY KẾ GIAO (0, 4400...)
 * - L: CÒN LẠI (-2110, -941...)
 * - M: TTĐB (3864, 5...)
 * - N: CẦN XỬ LÝ (-2110, -941...)
 */
@Injectable()
export class CDProductSheetsService {
  private readonly logger = new Logger(CDProductSheetsService.name);
  private sheets: any;

  // In-memory cache
  private dataCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 15000; // 15 seconds cache

  // Request throttling
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 100; // 100ms between requests

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
      this.logger.log('✅ CD Product Sheets Service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Google Sheets API for CD Products:', error);
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
      this.logger.warn('Google Sheets connection test failed for CD Products:', error.message);
    }
  }

  /**
   * Throttle API requests to avoid burst calls
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
   * Get sheet data with retry logic
   */
  async getSheetData(sheetName: string, range?: string): Promise<any[][]> {
    try {
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID');

      if (!range) {
        range = 'A1:N1000'; // Default range for columns A-N
      }

      const maxRetries = 3;
      let lastError: any;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
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
              `⏳ CD Products: Quota exceeded for ${sheetName}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`,
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
      this.logger.error(`❌ CD Products: Failed to fetch data from sheet ${sheetName}:`, error);
      return [];
    }
  }

  /**
   * Get production data by sheet code (cd1, cd2, cd3, cd4)
   * Returns data grouped by MÃ HÀNG (column E)
   *
   * @param code - Sheet code (cd1, cd2, cd3, cd4)
   * @returns Grouped data by product code
   */
  async getProductionDataBySheet(code: string): Promise<any> {
    try {
      const sheetCode = code.toUpperCase(); // CD1, CD2, CD3, CD4
      const cacheKey = `cd_product_${sheetCode}`;

      // Check cache
      const cached = this.dataCache.get(cacheKey);
      const now = Date.now();

      if (cached && now - cached.timestamp < this.CACHE_TTL) {
        this.logger.debug(`📦 CD Products: Using cached data for ${sheetCode}`);
        return cached.data;
      }

      this.logger.log(`📊 CD Products: Fetching data from sheet ${sheetCode}`);

      // Read sheet data (columns A-N)
      const values = await this.getSheetData(sheetCode, 'A1:N1000');

      if (values.length <= 1) {
        this.logger.warn(`CD Products: No data found in ${sheetCode} sheet`);
        return this.getEmptyResponse(sheetCode);
      }

      const headers = values[0]; // Row 1: Headers
      const dataRows = values.slice(1); // Data rows

      // Parse data grouped by MÃ HÀNG (column E)
      const result = this.parseGroupedData(dataRows, sheetCode);

      // Cache result
      this.dataCache.set(cacheKey, { data: result, timestamp: Date.now() });

      return result;
    } catch (error) {
      this.logger.error(`CD Products: Failed to get data for ${code}:`, error);
      return this.getEmptyResponse(code.toUpperCase());
    }
  }

  /**
   * Parse data and group by MÃ HÀNG (column E)
   * Each product group contains multiple detail rows
   */
  private parseGroupedData(dataRows: any[][], sheetCode: string): any {
    const products = new Map<string, any>();

    // Metadata from first row (should be consistent)
    let maChuyenLine = '';
    let factory = '';
    let line = '';
    let to = '';

    let currentProduct: any = null;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];

      // Column E: MÃ (product code)
      const ma = (row[4] || '').toString().trim();

      // If MÃ is not empty, this is a new product group
      if (ma !== '') {
        // Save previous product if exists
        if (currentProduct) {
          products.set(currentProduct.ma, currentProduct);
        }

        // Start new product group
        currentProduct = {
          ma: ma, // E: MÃ (CEM07, CEN91...)
          mau: (row[5] || '').toString().trim(), // F: MẪU (B4Z5D, B4Z38...)
          slkh: this.parseNumber(row[6]), // G: SLKH (5341, 6739...)
          nhuCauLuyKe: this.parseNumber(row[7]), // H: NHU CẦU LŨY KẾ
          tenChiTiet: (row[8] || '').toString().trim(), // I: TÊN CHI TIẾT
          keHoachGiao: this.parseNumber(row[9]), // J: KẾ HOẠCH GIAO
          luyKeGiao: this.parseNumber(row[10]), // K: LŨY KẾ GIAO
          conLai: this.parseNumber(row[11]), // L: CÒN LẠI
          ttdb: this.parseNumber(row[12]), // M: TTĐB
          canXuLy: this.parseNumber(row[13]), // N: CẦN XỬ LÝ
          details: [], // Chi tiết (Thân, Hồng túi, QX dưới không...)
        };

        // Get metadata from first product row
        if (!maChuyenLine) {
          maChuyenLine = (row[0] || '').toString().trim(); // A: MÃ CHUYỀN
          factory = (row[1] || '').toString().trim(); // B: NHÀ MÁY
          line = (row[2] || '').toString().trim(); // C: LINE
          to = (row[3] || '').toString().trim(); // D: TỔ
        }
      } else {
        // This is a detail row (no MÃ, belongs to current product)
        if (currentProduct) {
          const nhuCauLuyKe = this.parseNumber(row[7]); // H: NHU CẦU LŨY KẾ
          const tenChiTiet = (row[8] || '').toString().trim(); // I: TÊN CHI TIẾT (Thân, Hồng túi...)

          if (nhuCauLuyKe > 0 || tenChiTiet !== '') {
            currentProduct.details.push({
              nhuCauLuyKe: nhuCauLuyKe, // H: NHU CẦU LŨY KẾ
              tenChiTiet: tenChiTiet, // I: TÊN CHI TIẾT (detail name)
              keHoachGiao: this.parseNumber(row[9]), // J: KẾ HOẠCH GIAO
              luyKeGiao: this.parseNumber(row[10]), // K: LŨY KẾ GIAO
              conLai: this.parseNumber(row[11]), // L: CÒN LẠI
              ttdb: this.parseNumber(row[12]), // M: TTĐB
              canXuLy: this.parseNumber(row[13]), // N: CẦN XỬ LÝ
            });
          }
        }
      }
    }

    // Save last product
    if (currentProduct) {
      products.set(currentProduct.ma, currentProduct);
    }

    // Convert Map to Array
    const productsArray = Array.from(products.values());

    return {
      maChuyenLine: maChuyenLine,
      factory: factory,
      line: line,
      to: to,
      sheet: sheetCode,
      totalProducts: productsArray.length,
      products: productsArray,
      lastUpdate: new Date().toISOString(),
    };
  }

  /**
   * Parse number value
   */
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
   * Get empty response structure
   */
  private getEmptyResponse(sheetCode: string): any {
    return {
      maChuyenLine: '',
      factory: '',
      line: '',
      to: '',
      sheet: sheetCode,
      totalProducts: 0,
      products: [],
      lastUpdate: new Date().toISOString(),
    };
  }

  /**
   * Clear cache for specific sheet or all sheets
   */
  clearCache(sheetCode?: string) {
    if (sheetCode) {
      const cacheKey = `cd_product_${sheetCode.toUpperCase()}`;
      this.dataCache.delete(cacheKey);
      this.logger.log(`🗑️ CD Products: Cache cleared for ${sheetCode}`);
    } else {
      this.dataCache.clear();
      this.logger.log(`🗑️ CD Products: All cache cleared`);
    }
  }
}
