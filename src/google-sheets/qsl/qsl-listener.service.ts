import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { WebsocketGateway } from '../../websocket/websocket.gateway';
import { QSLSheetsService } from './qsl-sheets.service';

/**
 * QSL Listener Service
 * Monitors changes in LINE1, LINE2, LINE3, LINE4... sheets
 * Emits updates via WebSocket when data changes
 */
@Injectable()
export class QSLListenerService implements OnModuleInit {
  private readonly logger = new Logger(QSLListenerService.name);
  private previousData: Map<string, any> = new Map(); // Key: "qsl-line{number}"
  private isListening = false;
  private lastCheckTime: number = 0;

  // Configure which lines to monitor (can be configured via env)
  private readonly MONITORED_LINES = [1, 2, 3, 4]; // LINE1, LINE2, LINE3, LINE4

  constructor(
    private configService: ConfigService,
    private websocketGateway: WebsocketGateway,
    private qslSheetsService: QSLSheetsService,
  ) {}

  async onModuleInit() {
    await this.startRealtimeMonitoring();
  }

  async startRealtimeMonitoring() {
    if (this.isListening) {
      this.logger.warn('⚠️ QSL: Monitoring already started');
      return;
    }

    this.isListening = true;
    this.logger.log('🚀 QSL: Real-time monitoring started');

    await this.loadInitialData();
  }

  private async loadInitialData() {
    try {
      this.logger.log('📥 QSL: Loading initial data for all monitored lines...');

      for (const line of this.MONITORED_LINES) {
        try {
          const data = await this.qslSheetsService.getProductionDataByLine(line);
          const checksum = this.calculateChecksum(data);

          this.previousData.set(`qsl-line${line}`, {
            data,
            checksum,
            timestamp: Date.now(),
          });

          this.logger.log(`✅ QSL: Initial data loaded for LINE${line} (${data.totalTeams} teams)`);
        } catch (error) {
          this.logger.error(`❌ QSL: Failed to load initial data for LINE${line}:`, error.message);
        }
      }

      this.logger.log('✅ QSL: Initial data load complete');
    } catch (error) {
      this.logger.error('❌ QSL: Failed to load initial data:', error);
    }
  }

  /**
   * Cron job to check for changes every 5 minutes during work hours
   * Schedule: Every 5 minutes, 7AM-9PM, Mon-Sat
   */
  @Cron(process.env.QSL_CRON_SCHEDULE || '*/5 7-21 * * 1-6', {
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
      this.logger.debug(`⏭️ QSL: Skipping check at ${timeStr} (outside production hours)`);
      return;
    }

    this.logger.log(`⏰ QSL: Cron triggered at ${timeStr}`);

    // Prevent too frequent checks
    const now = Date.now();
    if (now - this.lastCheckTime < 60000) {
      // 1 minute minimum
      this.logger.debug('⏭️ QSL: Skipping check (too frequent)');
      return;
    }

    this.lastCheckTime = now;

    await this.performCheck();
  }

  /**
   * Perform change detection for all monitored lines
   */
  private async performCheck() {
    try {
      this.logger.log('🔍 QSL: Checking for changes in all monitored lines...');

      for (const line of this.MONITORED_LINES) {
        try {
          await this.checkLineForChanges(line);
        } catch (error) {
          this.logger.error(`❌ QSL: Error checking LINE${line}:`, error.message);
        }
      }

      this.logger.log('✅ QSL: Change detection complete');
    } catch (error) {
      this.logger.error('❌ QSL: Failed to perform check:', error);
    }
  }

  /**
   * Check specific line for changes
   */
  private async checkLineForChanges(line: number) {
    const cacheKey = `qsl-line${line}`;
    const currentData = await this.qslSheetsService.getProductionDataByLine(line);
    const currentChecksum = this.calculateChecksum(currentData);

    const previousRecord = this.previousData.get(cacheKey);

    if (!previousRecord) {
      // First time seeing this line
      this.previousData.set(cacheKey, {
        data: currentData,
        checksum: currentChecksum,
        timestamp: Date.now(),
      });

      this.logger.log(`🆕 QSL: New data for LINE${line}`);

      await this.emitChange({
        line: line,
        type: 'new',
        data: currentData,
      });
      return;
    }

    // Check for changes
    if (currentChecksum !== previousRecord.checksum) {
      this.logger.log(`🔄 QSL: Data changed for LINE${line}`);

      const changes = this.detectChanges(previousRecord.data, currentData);

      // Update stored data
      this.previousData.set(cacheKey, {
        data: currentData,
        checksum: currentChecksum,
        timestamp: Date.now(),
      });

      await this.emitChange({
        line: line,
        type: 'updated',
        data: currentData,
        changes: changes,
      });
    } else {
      this.logger.debug(`✓ QSL: No changes for LINE${line}`);
    }
  }

  /**
   * Emit change via WebSocket
   */
  private async emitChange(change: { line: number; type: string; data: any; changes?: any }) {
    const { line, type, data, changes } = change;

    // Emit to specific line subscribers
    const roomName = `qsl-line${line}`;
    const roomSize = this.websocketGateway.server.sockets.adapter.rooms.get(roomName)?.size || 0;

    this.logger.log(`📡 QSL: Emitting ${type} to ${roomName} (${roomSize} clients)`);

    this.websocketGateway.server.to(roomName).emit('qsl-update', {
      line: line,
      type: type,
      data: data,
      changes: changes,
      timestamp: new Date().toISOString(),
      _debug: {
        sheetSource: `LINE${line}`,
        updateTime: new Date().toLocaleTimeString('vi-VN'),
      },
    });

    if (roomSize === 0) {
      this.logger.debug(`⚠️ QSL: No clients subscribed to ${roomName}`);
    }
  }

  /**
   * Calculate checksum from data
   * Includes all teams and their groups
   */
  private calculateChecksum(data: any): string {
    try {
      const checksumParts: string[] = [];

      for (const team of data.teams || []) {
        // Team info
        checksumParts.push(`${team.tenTo}:${team.tglv}`);

        // Fixed groups
        for (const group of team.fixedGroups || []) {
          checksumParts.push(this.serializeGroupData(group));
        }

        // TÚI NHỎ groups
        for (const group of team.tuiNhoGroups || []) {
          checksumParts.push(this.serializeGroupData(group));
        }
      }

      return checksumParts.join('|');
    } catch (error) {
      this.logger.error('Failed to calculate checksum:', error);
      return '';
    }
  }

  /**
   * Serialize group data for checksum
   */
  private serializeGroupData(group: any): string {
    const hourly = group.hourly || {};
    return [
      group.nhom,
      group.ldLayout,
      group.thucTe,
      group.keHoach,
      hourly.h8h30,
      hourly.h9h30,
      hourly.h10h30,
      hourly.h11h30,
      hourly.h13h30,
      hourly.h14h30,
      hourly.h15h30,
      hourly.h16h30,
      hourly.h18h,
      hourly.h19h,
      hourly.h20h,
      group.luyKeThucHien,
      group.luyKeKeHoach,
      group.percentHT,
    ].join(':');
  }

  /**
   * Detect specific changes between old and new data
   */
  private detectChanges(oldData: any, newData: any): any {
    const changes: any = {
      teamsAdded: [],
      teamsRemoved: [],
      teamsModified: [],
    };

    // Build maps for comparison
    const oldTeams = new Map((oldData.teams || []).map((t: any) => [t.tenTo, t]));
    const newTeams = new Map((newData.teams || []).map((t: any) => [t.tenTo, t]));

    // Check for added teams
    for (const [tenTo, newTeam] of newTeams) {
      if (!oldTeams.has(tenTo)) {
        changes.teamsAdded.push(tenTo);
      } else {
        // Check if team modified
        const oldTeam = oldTeams.get(tenTo);
        if (this.isTeamModified(oldTeam, newTeam)) {
          changes.teamsModified.push(tenTo);
        }
      }
    }

    // Check for removed teams
    for (const tenTo of oldTeams.keys()) {
      if (!newTeams.has(tenTo)) {
        changes.teamsRemoved.push(tenTo);
      }
    }

    return changes;
  }

  /**
   * Check if team data is modified
   */
  private isTeamModified(oldTeam: any, newTeam: any): boolean {
    const oldChecksum = this.calculateChecksum({ teams: [oldTeam] });
    const newChecksum = this.calculateChecksum({ teams: [newTeam] });
    return oldChecksum !== newChecksum;
  }

  /**
   * Check if current time is in active production block
   */
  private isInActiveProductionBlock(date: Date): boolean {
    const hour = date.getHours();
    // Active during work hours: 7AM - 9PM
    return hour >= 7 && hour <= 21;
  }

  stopRealtimeMonitoring() {
    this.isListening = false;
    this.logger.log('🛑 QSL: Monitoring stopped');
  }

  getMonitoringStats() {
    return {
      isListening: this.isListening,
      monitoredLines: this.MONITORED_LINES,
      trackedLines: this.previousData.size,
      lastCheckTime: this.lastCheckTime ? new Date(this.lastCheckTime).toISOString() : null,
    };
  }

  /**
   * Manual trigger for testing
   */
  async manualCheckForChanges() {
    await this.performCheck();
  }
}
