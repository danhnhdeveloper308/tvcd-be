import { Controller, Get, Query, Logger, Post } from '@nestjs/common';
import { ApiTags, ApiOperation,  ApiQuery } from '@nestjs/swagger';
import { CDProductSheetsService } from '../google-sheets/cd/cd-product-sheets.service';
import { CDProductListenerService } from '../google-sheets/cd/cd-product-listener.service';
// import { QSLSheetsService } from 'src/google-sheets/qsl/qsl-sheets.service';
// import { QSLListenerService } from 'src/google-sheets/qsl/qsl-listener.service';

@ApiTags('display')
@Controller('display')
export class DisplayRouterController {
  private readonly logger = new Logger(DisplayRouterController.name);

  constructor(
    private readonly cdProductSheetsService: CDProductSheetsService,
    private readonly cdProductListenerService: CDProductListenerService,
    //  private readonly qslSheetsService: QSLSheetsService,
    // private readonly qslListenerService: QSLListenerService,
  ) {}

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


  /**
   * ⭐ QSL endpoint - Get data by line number (1, 2, 3, 4...)
   * Returns data grouped by TỔ (Team)
   */
  // @Get('qsl')
  // @ApiOperation({
  //   summary: 'QSL Display - Get data by line number',
  //   description:
  //     'Returns QSL production data (QUAI, SƠN, LÓT) grouped by TỔ. Each team contains 8 fixed groups + TÚI NHỎ groups (if applicable).',
  // })
  // @ApiQuery({
  //   name: 'line',
  //   example: 1,
  //   required: true,
  //   description: 'Line number: 1, 2, 3, 4...',
  // })
  // async getQSLData(@Query('line') line: string) {
  //   if (!line) {
  //     return {
  //       success: false,
  //       error: 'Missing required parameter: line',
  //       examples: {
  //         line1: '/api/display/qsl?line=1',
  //         line2: '/api/display/qsl?line=2',
  //         line3: '/api/display/qsl?line=3',
  //         line4: '/api/display/qsl?line=4',
  //       },
  //     };
  //   }

  //   try {
  //     const lineNumber = parseInt(line, 10);

  //     if (isNaN(lineNumber) || lineNumber < 1) {
  //       return {
  //         success: false,
  //         error: `Invalid line number: ${line}. Must be a positive integer (1, 2, 3, 4...)`,
  //       };
  //     }

  //     this.logger.log(`📊 QSL: Fetching data for LINE${lineNumber}`);

  //     const data = await this.qslSheetsService.getProductionDataByLine(lineNumber);

  //     return {
  //       success: true,
  //       data: data,
  //       timestamp: new Date().toISOString(),
  //       _debug: {
  //         endpoint: 'qsl',
  //         line: lineNumber,
  //         sheetName: `LINE${lineNumber}`,
  //         totalTeams: data.totalTeams,
  //       },
  //     };
  //   } catch (error) {
  //     this.logger.error(`Failed to get QSL data for line ${line}:`, error);
  //     return {
  //       success: false,
  //       error: error.message,
  //       timestamp: new Date().toISOString(),
  //     };
  //   }
  // }

  /**
   * ⭐ Manually trigger QSL sheets change detection
   */
  // @Post('qsl/check-changes')
  // @ApiOperation({
  //   summary: 'Manually trigger QSL sheets change detection',
  //   description:
  //     'Forces an immediate check for changes in QSL sheets (LINE1, LINE2, LINE3, LINE4...). Useful for testing without waiting for cron.',
  // })
  // async triggerQSLCheck() {
  //   try {
  //     this.logger.log('🔧 Manual QSL check triggered via API');
  //     await this.qslListenerService.manualCheckForChanges();

  //     const stats = this.qslListenerService.getMonitoringStats();

  //     return {
  //       success: true,
  //       message: 'QSL sheets check completed',
  //       stats: stats,
  //       timestamp: new Date().toISOString(),
  //     };
  //   } catch (error) {
  //     this.logger.error('Failed to trigger QSL check:', error);
  //     return {
  //       success: false,
  //       error: error.message,
  //       timestamp: new Date().toISOString(),
  //     };
  //   }
  // }
}
