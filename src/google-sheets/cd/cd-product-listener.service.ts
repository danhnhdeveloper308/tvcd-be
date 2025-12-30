import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { WebsocketGateway } from '../../websocket/websocket.gateway';
import { CDProductSheetsService } from './cd-product-sheets.service';

/**
 * CD Product Listener Service - NEW FORMAT
 * Monitors changes in CD1, CD2, CD3, CD4 sheets
 * Emits updates via WebSocket when data changes
 */
@Injectable()
export class CDProductListenerService implements OnModuleInit {
  private readonly logger = new Logger(CDProductListenerService.name);
  private previousData: Map<string, any> = new Map(); // Key: sheet code (CD1, CD2, CD3, CD4)
  private isListening = false;
  private lastCheckTime: number = 0;

  constructor(
    private configService: ConfigService,
    private websocketGateway: WebsocketGateway,
    private cdProductSheetsService: CDProductSheetsService,
  ) {}

  async onModuleInit() {
    await this.startRealtimeMonitoring();
  }

  async startRealtimeMonitoring() {
    if (this.isListening) {
      this.logger.warn('CD Product real-time monitoring already started');
      return;
    }

    this.isListening = true;
    this.logger.log('🚀 CD Products: Real-time monitoring started');

    await this.loadInitialData();
  }

  private async loadInitialData() {
    try {
      const sheetCodes = ['CD1', 'CD2', 'CD3', 'CD4'];

      for (const sheetCode of sheetCodes) {
        const data = await this.cdProductSheetsService.getProductionDataBySheet(sheetCode);

        if (data && data.products.length > 0) {
          this.previousData.set(sheetCode, {
            data: data,
            checksum: this.calculateChecksum(data),
          });

          this.logger.log(
            `📦 CD Products: Loaded initial data for ${sheetCode} - ${data.totalProducts} products`,
          );
        }
      }
    } catch (error) {
      this.logger.error('❌ CD Products: Failed to load initial data:', error);
    }
  }

  /**
   * Cron job to check for changes every 2 minutes during work hours
   * Schedule: Every 2 minutes, 7AM-9PM, Mon-Sat
   */
  @Cron(process.env.CD_PRODUCT_CRON_SCHEDULE || '*/2 7-21 * * 1-6', {
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async checkForChanges() {
    if (!this.isListening) return;

    const vietnamTime = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }),
    );
    const timeStr = vietnamTime.toLocaleTimeString('vi-VN');

    // Check if in active production hours
    if (!this.isInActiveProductionBlock(vietnamTime)) {
      return;
    }

    this.logger.log(`⏰ CD Products: Cron triggered at ${timeStr}`);

    // Prevent too frequent checks
    const now = Date.now();
    if (now - this.lastCheckTime < 60000) {
      // Minimum 1 minute between checks
      this.logger.debug('⏸️ CD Products: Skipping check (too soon after last check)');
      return;
    }

    this.lastCheckTime = now;

    await this.performCheck();
  }

  /**
   * Perform change detection for all CD sheets
   */
  private async performCheck() {
    try {
      const sheetCodes = ['CD1', 'CD2', 'CD3', 'CD4'];

      for (const sheetCode of sheetCodes) {
        try {
          // Fetch fresh data (bypass cache)
          this.cdProductSheetsService.clearCache(sheetCode);
          const currentData = await this.cdProductSheetsService.getProductionDataBySheet(sheetCode);

          if (!currentData || currentData.totalProducts === 0) {
            this.logger.debug(`⏭️ CD Products: No data for ${sheetCode}, skipping`);
            continue;
          }

          const currentChecksum = this.calculateChecksum(currentData);
          const previous = this.previousData.get(sheetCode);

          if (!previous) {
            // First time seeing this sheet
            this.previousData.set(sheetCode, {
              data: currentData,
              checksum: currentChecksum,
            });

            this.logger.log(
              `🆕 CD Products: First time data for ${sheetCode} - ${currentData.totalProducts} products`,
            );

            // Emit as new data
            await this.emitChange({
              sheetCode: sheetCode,
              type: 'new',
              data: currentData,
            });
          } else if (previous.checksum !== currentChecksum) {
            // Data changed
            this.logger.log(`🔄 CD Products: Data changed for ${sheetCode}`);
            this.logger.debug(`   Previous checksum: ${previous.checksum}`);
            this.logger.debug(`   Current checksum:  ${currentChecksum}`);

            // Detect what changed
            const changes = this.detectChanges(previous.data, currentData);
            this.logger.log(`   Changes: ${JSON.stringify(changes)}`);

            // Update stored data
            this.previousData.set(sheetCode, {
              data: currentData,
              checksum: currentChecksum,
            });

            // Emit update
            await this.emitChange({
              sheetCode: sheetCode,
              type: 'updated',
              data: currentData,
              changes: changes,
            });
          } else {
            this.logger.debug(`✅ CD Products: No changes for ${sheetCode}`);
          }
        } catch (error) {
          this.logger.error(`❌ CD Products: Error checking ${sheetCode}:`, error);
        }
      }
    } catch (error) {
      this.logger.error(`❌ CD Products: Error in performCheck:`, error);
    }
  }

  /**
   * Emit change via WebSocket
   */
  private async emitChange(change: { sheetCode: string; type: string; data: any; changes?: any }) {
    const { sheetCode, type, data, changes } = change;

    // Emit to specific sheet subscribers
    const roomName = `cd-product-${sheetCode.toLowerCase()}`;
    const roomSize = this.websocketGateway.server.sockets.adapter.rooms.get(roomName)?.size || 0;

    this.logger.log(`📡 CD Products: Emitting ${type} to ${roomName} (${roomSize} clients)`);

    this.websocketGateway.server.to(roomName).emit('cd-product-update', {
      sheet: sheetCode,
      type: type,
      data: data,
      changes: changes,
      timestamp: new Date().toISOString(),
      _debug: {
        sheetSource: `CD_PRODUCT_${sheetCode}`,
        updateTime: new Date().toLocaleTimeString('vi-VN'),
      },
    });

    if (roomSize === 0) {
      this.logger.debug(`   ⚠️ No clients subscribed to ${roomName}`);
    }
  }

  /**
   * Calculate checksum from data
   * Includes all products and their details
   */
  private calculateChecksum(data: any): string {
    try {
      const checksumData = {
        maChuyenLine: data.maChuyenLine || '',
        factory: data.factory || '',
        line: data.line || '',
        totalProducts: data.totalProducts || 0,
        products: (data.products || []).map((product: any) => ({
          ma: product.ma,
          mau: product.mau,
          slkh: product.slkh,
          nhuCauLuyKe: product.nhuCauLuyKe,
          tenChiTiet: product.tenChiTiet,
          keHoachGiao: product.keHoachGiao,
          luyKeGiao: product.luyKeGiao,
          conLai: product.conLai,
          ttdb: product.ttdb,
          canXuLy: product.canXuLy,
          details: product.details.map((detail: any) => ({
            nhuCauLuyKe: detail.nhuCauLuyKe,
            tenChiTiet: detail.tenChiTiet,
            keHoachGiao: detail.keHoachGiao,
            luyKeGiao: detail.luyKeGiao,
            conLai: detail.conLai,
            ttdb: detail.ttdb,
            canXuLy: detail.canXuLy,
          })),
        })),
      };

      return JSON.stringify(checksumData);
    } catch (error) {
      this.logger.error('Error calculating checksum:', error);
      return '';
    }
  }

  /**
   * Detect specific changes between old and new data
   */
  private detectChanges(oldData: any, newData: any): any {
    const changes: any = {
      productsAdded: [],
      productsRemoved: [],
      productsModified: [],
      detailsModified: [],
    };

    // Build maps for comparison
    const oldProducts = new Map(oldData.products.map((p: any) => [p.ma, p]));
    const newProducts = new Map(newData.products.map((p: any) => [p.ma, p]));

    // Check for added products
    for (const [ma, product] of newProducts) {
      if (!oldProducts.has(ma)) {
        changes.productsAdded.push(ma);
      } else {
        // Check if product data modified
        const oldProduct = oldProducts.get(ma);
        const productChanged = this.isProductModified(oldProduct, product);

        if (productChanged) {
          changes.productsModified.push({
            ma: ma,
            fields: productChanged,
          });
        }
      }
    }

    // Check for removed products
    for (const [ma] of oldProducts) {
      if (!newProducts.has(ma)) {
        changes.productsRemoved.push(ma);
      }
    }

    return changes;
  }

  /**
   * Check if product data is modified
   */
  private isProductModified(oldProduct: any, newProduct: any): string[] | null {
    const modifiedFields: string[] = [];

    const fieldsToCheck = [
      'slkh',
      'nhuCauLuyKe',
      'tenChiTiet',
      'keHoachGiao',
      'luyKeGiao',
      'conLai',
      'ttdb',
      'canXuLy',
    ];

    for (const field of fieldsToCheck) {
      if (oldProduct[field] !== newProduct[field]) {
        modifiedFields.push(field);
      }
    }

    // Check details
    if (JSON.stringify(oldProduct.details) !== JSON.stringify(newProduct.details)) {
      modifiedFields.push('details');
    }

    return modifiedFields.length > 0 ? modifiedFields : null;
  }

  /**
   * Check if current time is in active production block
   */
  private isInActiveProductionBlock(date: Date): boolean {
    const hour = date.getHours();
    const minute = date.getMinutes();

    // Active hours: 7:00 - 21:00
    if (hour < 7 || hour >= 21) {
      return false;
    }

    return true;
  }

  stopRealtimeMonitoring() {
    this.isListening = false;
    this.logger.log('🛑 CD Products: Real-time monitoring stopped');
  }

  getMonitoringStats() {
    return {
      isListening: this.isListening,
      lastCheckTime: this.lastCheckTime,
      monitoredSheets: Array.from(this.previousData.keys()),
      totalProducts: Array.from(this.previousData.values()).reduce(
        (sum, v) => sum + (v.data.totalProducts || 0),
        0,
      ),
    };
  }

  /**
   * Manual trigger for testing
   */
  async manualCheckForChanges() {
    this.logger.log('🔧 CD Products: Manual check triggered');
    await this.performCheck();
  }
}
