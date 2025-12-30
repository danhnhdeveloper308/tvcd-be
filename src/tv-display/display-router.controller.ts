import { Controller, Get, Query, Logger, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { HTMSheetsService } from '../google-sheets/htm/htm-sheets.service';
import { HTMCenterTVService } from '../google-sheets/htm/htm-center-tv.service';
import { CDSheetsService } from '../google-sheets/cd/cd-sheets.service';
import { CDProductSheetsService } from '../google-sheets/cd/cd-product-sheets.service';
import { HTMSheetsListenerService } from '../google-sheets/htm/htm-sheets-listener.service';
import { CDProductListenerService } from '../google-sheets/cd/cd-product-listener.service';

@ApiTags('display')
@Controller('display')
export class DisplayRouterController {
  private readonly logger = new Logger(DisplayRouterController.name);

  constructor(
    private readonly htmSheetsService: HTMSheetsService,
    private readonly htmCenterTVService: HTMCenterTVService,
    private readonly cdSheetsService: CDSheetsService,
    private readonly cdProductSheetsService: CDProductSheetsService,
    private readonly htmSheetsListener: HTMSheetsListenerService,
    private readonly cdProductListenerService: CDProductListenerService,
  ) {}

  /**
   * Auto-detect line type and route to appropriate service
   */
  @Get('tv')
  @ApiOperation({
    summary: 'Smart TV Display endpoint - auto-detects HTM or CD line',
    description:
      'Automatically routes to HTM or CD service based on code format. For CD: returns all 4 lines by factory. Supports index parameter for ENDLINE data filtering.',
  })
  @ApiQuery({ name: 'code', example: 'KVHB07M01 or KVHB07CD26' })
  @ApiQuery({
    name: 'factory',
    required: false,
    example: 'TS3',
    description: 'Optional: Override factory detection for CD lines',
  })
  @ApiQuery({
    name: 'index',
    required: false,
    example: '0',
    description: 'Optional: Team index for ENDLINE RFT data filtering (0=Tổ 1, 1=Tổ 2, etc.)',
  })
  async getTVData(
    @Query('code') code: string,
    @Query('factory') factoryParam?: string,
    @Query('index') index?: string, // ⭐ NEW: Add index parameter for ENDLINE filtering
  ) {
    if (!code) {
      return {
        success: false,
        error: 'Missing required parameter: code',
        examples: {
          htm: '/api/display/tv?code=KVHB07M01',
          cd: '/api/display/tv?code=KVHB07CD26',
          cdWithFactory: '/api/display/tv?code=KVHB07CD26&factory=TS3',
        },
      };
    }

    const lineType = this.detectLineType(code);
    try {
      if (lineType === 'CD') {
        // ✅ Use factoryParam if provided, otherwise extract from code
        const factory = factoryParam || this.extractFactoryFromCDCode(code);

        // Route to CD service - get data by specific factory ONLY (returns 4 lines)
        const data = await this.cdSheetsService.getProductionData(factory);

        // ✅ Verify factory in response
        if (data && data.length > 0) {
          const factories = [...new Set(data.map(d => d.nhaMay))];

          // Validate factory correctness
          if (factories.length > 1) {
            this.logger.warn(
              `⚠️ CD TV: Expected single factory ${factory} but got multiple: ${factories.join(', ')}`,
            );
          } else if (factories[0] !== factory) {
            this.logger.warn(`⚠️ CD TV: Expected ${factory} but got ${factories[0]}`);
          }
        }

        if (!data || data.length === 0) {
          return {
            success: false,
            error: `No CD data found for factory: ${factory}`,
            code,
            factory,
            lineType: 'CD',
            timestamp: new Date().toISOString(),
          };
        }

        // Find the requested line
        const record = data.find(r => r.maChuyenLine === code);

        if (!record) {
          this.logger.warn(`⚠️ CD TV: Line ${code} not found in response`);
          return {
            success: false,
            error: `No CD line found for code: ${code}`,
            factory,
            availableLines: data.map(r => r.maChuyenLine),
            lineType: 'CD',
            timestamp: new Date().toISOString(),
          };
        }

        // All lines should already be from the same factory
        const factoryLines = data; // Already filtered by factory in getProductionData()

        // Return CD data with all 4 lines for the factory
        return {
          success: true,
          code,
          lineType: 'CD',
          factory, // ✅ Return the actual factory used
          data: factoryLines.map(line => ({
            ...line,
            canBoQuanLy: line.canBoQuanLy || '', // ⭐ Ensure canBoQuanLy is included
            // Transform hourlyData for frontend compatibility
            hourlyData: line.hourlyData || {},
            subRows: line.subRows || [],
            monthlyPlanData: line.monthlyPlanData || {},
            ncdvTotal: line.ncdvTotal || line.ncdv || 0,
            dbcuTotal: line.dbcuTotal || line.dbcu || 0,
            tonMayTotal: line.tonMayTotal || line.tonMay || 0,
            nc1nttTotal: line.nc1nttTotal || line.nc1ntt || 0,
            nc2nttTotal: line.nc2nttTotal || line.nc2ntt || 0,
            nc3nttTotal: line.nc3nttTotal || line.nc3ntt || 0,
            db1nttTotal: line.db1nttTotal || line.db1ntt || 0,
            db2nttTotal: line.db2nttTotal || line.db2ntt || 0,
            db3nttTotal: line.db3nttTotal || line.db3ntt || 0,
            dbNgayTotal: line.dbNgayTotal || line.dbNgay || 0,
          })),
          count: factoryLines.length,
          timestamp: new Date().toISOString(),
        };
      } else {
        // Route to HTM service (default)
        const teamIndex = index !== undefined ? parseInt(index) : undefined;
        const factory = factoryParam?.toUpperCase() || 'ALL';

        // If index parameter is provided, merge DATA BCSL HTM + ENDLINE
        if (teamIndex !== undefined && !isNaN(teamIndex)) {
          this.logger.log(
            `📍 HTM TV: Fetching merged DATA BCSL HTM + ENDLINE for code=${code}, index=${teamIndex}, factory=${factory}`,
          );

          // ⚠️ ALWAYS bypass cache for TV displays
          const mergedData = await this.htmSheetsService.getProductionDataWithEndlineMerge(
            code,
            factory,
            teamIndex,
            true,
          );

          if (!mergedData) {
            return {
              success: false,
              error: `Failed to merge data for code ${code}, row index ${teamIndex}, factory ${factory}`,
              lineType: 'HTM',
              code,
              timestamp: new Date().toISOString(),
            };
          }

          this.logger.log(
            `✅ HTM TV: Merged successfully - maChuyenLine=${mergedData.maChuyenLine}, slth=${mergedData.slth}, tongKiem=${mergedData.tongKiem}, rft=${mergedData.rft}%`,
          );

          return {
            success: true,
            code,
            lineType: 'HTM',
            source: 'MERGED',
            rowIndex: teamIndex,
            factory,
            data: mergedData,
            timestamp: new Date().toISOString(),
            _debug: mergedData._debug, // ⭐ Pass debug info to frontend
          };
        }

        // Normal flow: get data from DATA BCSL HTM sheet
        const data = await this.htmSheetsService.getProductionData(factory);
        const record = data.find(r => r.maChuyenLine === code);

        if (!record) {
          this.logger.warn(
            `⚠️ HTM TV: Code ${code} not found in DATA BCSL HTM. Available codes: ${data
              .slice(0, 5)
              .map(r => r.maChuyenLine)
              .join(', ')}...`,
          );
          return {
            success: false,
            error: `No HTM data found for: ${code}`,
            lineType: 'HTM',
            timestamp: new Date().toISOString(),
          };
        }

        return {
          success: true,
          code,
          lineType: 'HTM',
          source: 'DATA_BCSL_HTM',
          data: record,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.logger.error(`Error getting TV data for ${code}:`, error);
      return {
        success: false,
        error: 'Failed to fetch data',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get production lines list (combined HTM + CD) with QSL data
   */
  @Get('lines')
  @ApiOperation({
    summary: 'Get all production lines (HTM + CD) with QSL groups data',
    description:
      'Returns combined list of HTM and CD production lines with Quai/Sơn/Lót group information',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['HTM', 'CD', 'ALL'],
    example: 'ALL',
  })
  @ApiQuery({
    name: 'includeQSL',
    required: false,
    type: Boolean,
    example: true,
    description: 'Include QSL (Quai/Sơn/Lót) group data for HTM lines',
  })
  async getProductionLines(
    @Query('type') type: string = 'ALL',
    @Query('includeQSL') includeQSL: string = 'true',
  ) {
    try {
      const shouldIncludeQSL = includeQSL === 'true';

      let htmLines: any[] = [];
      let cdLines: any[] = [];

      if (type === 'HTM' || type === 'ALL') {
        htmLines = await this.htmSheetsService.getProductionLinesList();

        // Add QSL data for HTM lines if requested
        if (shouldIncludeQSL) {
          htmLines = await Promise.all(
            htmLines.map(async line => {
              try {
                // Extract factory and line number from the line data
                const factory = line.factory || line.nhaMay;
                const lineNumber = line.line;

                if (factory && lineNumber) {
                  // Fetch QSL data for this line
                  const qslData = await this.htmCenterTVService.getCenterTVData(
                    factory,
                    lineNumber,
                  );

                  return {
                    ...line,
                    lineType: 'HTM',
                    // qslGroups: qslData.groups || [],
                    qslSummary: qslData.groups
                      ? {
                          totalGroups: qslData.groups.length,
                          groups: qslData.groups.map((g: any) => ({
                            name: g.groupName,
                            code: g.code,
                            layout: g.layout,
                            coMat: g.coMat,
                            keHoachNgay: g.keHoachNgay,
                            keHoachGio: g.keHoachGio,
                            lkKh: g.lkKh,
                            lkTh: g.lkTh,
                            phanTramHt: g.phanTramHt,
                          })),
                        }
                      : null,
                  };
                }

                return { ...line, lineType: 'HTM', qslGroups: [], qslSummary: null };
              } catch (error) {
                this.logger.warn(`Failed to fetch QSL data for line ${line.code}:`, error);
                return { ...line, lineType: 'HTM', qslGroups: [], qslSummary: null };
              }
            }),
          );
        } else {
          htmLines = htmLines.map(line => ({ ...line, lineType: 'HTM' }));
        }
      }

      if (type === 'CD' || type === 'ALL') {
        cdLines = await this.cdSheetsService.getProductionLinesList();
        cdLines = cdLines.map(line => ({ ...line, lineType: 'CD' }));
      }

      const allLines = [...htmLines, ...cdLines];

      return {
        success: true,
        lines: allLines,
        count: {
          total: allLines.length,
          htm: htmLines.length,
          cd: cdLines.length,
        },
        includeQSL: shouldIncludeQSL,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('❌ Error fetching production lines:', error);
      return {
        success: false,
        error: 'Failed to fetch production lines',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Get data by line type
   */
  @Get(':lineType/data')
  @ApiOperation({
    summary: 'Get production data by line type',
    description: 'Fetch HTM or CD data explicitly',
  })
  @ApiQuery({ name: 'factory', required: false, example: 'TS1' })
  async getDataByType(
    @Param('lineType') lineType: string,
    @Query('factory') factory: string = 'ALL',
  ) {
    try {
      if (lineType.toUpperCase() === 'HTM') {
        const data = await this.htmSheetsService.getProductionData(factory);
        return {
          success: true,
          lineType: 'HTM',
          factory,
          data,
          count: data.length,
          timestamp: new Date().toISOString(),
        };
      } else if (lineType.toUpperCase() === 'CD') {
        const data = await this.cdSheetsService.getProductionData(factory);
        return {
          success: true,
          lineType: 'CD',
          factory,
          data,
          count: data.length,
          timestamp: new Date().toISOString(),
        };
      } else {
        return {
          success: false,
          error: `Invalid line type: ${lineType}`,
          validTypes: ['HTM', 'CD'],
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.logger.error(`Error fetching ${lineType} data:`, error);
      return {
        success: false,
        error: 'Failed to fetch data',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * HTM Center TV endpoint - Get data by factory and line (3 groups: Quai-Sơn-Lót)
   */
  @Get('center-tv')
  @ApiOperation({
    summary: 'HTM Center TV Display - Get 3 groups (Quai-Sơn-Lót) by factory and line',
    description: 'Returns data for center TV display with 3 groups per line from DATA sheet',
  })
  @ApiQuery({ name: 'factory', example: 'TS1', required: true })
  @ApiQuery({ name: 'line', example: '1', required: true })
  async getCenterTVData(@Query('factory') factory: string, @Query('line') line: string) {
    if (!factory || !line) {
      return {
        success: false,
        error: 'Missing required parameters: factory and line',
        examples: {
          example1: '/api/display/center-tv?factory=TS1&line=1',
          example2: '/api/display/center-tv?factory=TS2&line=3',
        },
      };
    }

    try {
      const data = await this.htmCenterTVService.getCenterTVData(factory, line);

      if (!data.groups || data.groups.length === 0) {
        return {
          success: false,
          error: `No data found for ${factory} LINE ${line}`,
          factory,
          line,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        success: true,
        factory,
        line,
        data: {
          groups: data.groups,
          summary: {
            totalGroups: data.groups.length,
            totalLayout: data.groups.reduce((sum: number, g: any) => sum + (g.layout || 0), 0),
            totalKeHoachNgay: data.groups.reduce(
              (sum: number, g: any) => sum + (g.keHoachNgay || 0),
              0,
            ),
            totalLkTh: data.groups.reduce((sum: number, g: any) => sum + (g.lkTh || 0), 0),
            totalLkKh: data.groups.reduce((sum: number, g: any) => sum + (g.lkKh || 0), 0),
            averagePhanTramHt:
              data.groups.reduce((sum: number, g: any) => sum + (g.phanTramHt || 0), 0) /
              data.groups.length,
          },
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Error getting Center TV data for ${factory} LINE ${line}:`, error);
      return {
        success: false,
        error: 'Failed to fetch Center TV data',
        factory,
        line,
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Detect line type from code
   */
  private detectLineType(code: string): 'HTM' | 'CD' {
    if (!code) return 'HTM';

    // CD lines have CD in the code (e.g., KVHB07CD27)
    if (code.includes('CD')) {
      return 'CD';
    }

    // Default to HTM
    return 'HTM';
  }

  /**
   * Extract factory from CD code
   */
  private extractFactoryFromCDCode(code: string): string {
    if (!code || !code.includes('CD')) return 'TS1';

    const match = code.match(/CD(\d+)/);
    if (!match) return 'TS1';

    const lineNumber = parseInt(match[1]);

    // KVHB07CD16-19 = TS1
    // KVHB07CD20-23 = TS2
    // KVHB07CD24-27 = TS3
    if (lineNumber >= 16 && lineNumber <= 19) return 'TS1';
    if (lineNumber >= 20 && lineNumber <= 23) return 'TS2';
    if (lineNumber >= 24 && lineNumber <= 27) return 'TS3';

    return 'TS1';
  }

  /**
   * Manual trigger for HTM sheets change detection (for testing)
   */
  @Post('htm/check-changes')
  @ApiOperation({
    summary: 'Manually trigger HTM sheets change detection',
    description:
      'Forces an immediate check for changes in HTM sheets data. Useful for testing without waiting for cron.',
  })
  async triggerHTMCheck() {
    try {
      this.logger.log('🔧 Manual HTM check triggered via API');
      await this.htmSheetsListener.manualCheckForChanges();
      return {
        success: true,
        message: 'HTM sheets check completed',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Failed to trigger HTM check:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * ⭐ NEW: CD Product endpoint - Get data by sheet code (CD1, CD2, CD3, CD4)
   * Returns data grouped by MÃ HÀNG (column E)
   */
  @Get('cd-product')
  @ApiOperation({
    summary: 'CD Product Display - Get data by sheet code (CD1-CD4)',
    description:
      'Returns production data grouped by MÃ HÀNG (product code). Each product contains multiple detail rows (Thân, Hồng túi, QX dưới không, Nẹp ĐK...)',
  })
  @ApiQuery({
    name: 'code',
    example: 'cd1',
    required: true,
    description: 'Sheet code: cd1, cd2, cd3, or cd4',
  })
  async getCDProductData(@Query('code') code: string) {
    if (!code) {
      return {
        success: false,
        error: 'Missing required parameter: code',
        examples: {
          cd1: '/api/display/cd-product?code=cd1',
          cd2: '/api/display/cd-product?code=cd2',
          cd3: '/api/display/cd-product?code=cd3',
          cd4: '/api/display/cd-product?code=cd4',
        },
      };
    }

    try {
      const validCodes = ['cd1', 'cd2', 'cd3', 'cd4'];
      const normalizedCode = code.toLowerCase();

      if (!validCodes.includes(normalizedCode)) {
        return {
          success: false,
          error: `Invalid code: ${code}. Must be one of: ${validCodes.join(', ')}`,
        };
      }

      this.logger.log(`📊 CD Product: Fetching data for ${normalizedCode.toUpperCase()}`);

      const data = await this.cdProductSheetsService.getProductionDataBySheet(normalizedCode);

      return {
        success: true,
        data: data,
        timestamp: new Date().toISOString(),
        _debug: {
          endpoint: 'cd-product',
          sheetCode: normalizedCode.toUpperCase(),
          totalProducts: data.totalProducts,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get CD product data for ${code}:`, error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * ⭐ NEW: Manually trigger CD Product sheets change detection
   */
  @Post('cd-product/check-changes')
  @ApiOperation({
    summary: 'Manually trigger CD Product sheets change detection',
    description:
      'Forces an immediate check for changes in CD Product sheets (CD1-CD4). Useful for testing without waiting for cron.',
  })
  async triggerCDProductCheck() {
    try {
      this.logger.log('🔧 Manual CD Product check triggered via API');
      await this.cdProductListenerService.manualCheckForChanges();

      const stats = this.cdProductListenerService.getMonitoringStats();

      return {
        success: true,
        message: 'CD Product sheets check completed',
        stats: stats,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Failed to trigger CD Product check:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
