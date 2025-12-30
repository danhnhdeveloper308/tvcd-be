import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebsocketGateway } from '../../websocket/websocket.gateway';
import { HTMCenterTVService } from './htm-center-tv.service';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class HTMCenterTVListenerService implements OnModuleInit {
  private readonly logger = new Logger(HTMCenterTVListenerService.name);
  private previousData: Map<string, any> = new Map(); // Key: factory_line (e.g., "TS1_1")
  private isListening = false;
  private lastCheckTime: number = 0;

  constructor(
    private configService: ConfigService,
    private websocketGateway: WebsocketGateway,
    private htmCenterTVService: HTMCenterTVService,
  ) {}

  async onModuleInit() {
    await this.startRealtimeMonitoring();
  }

  async startRealtimeMonitoring() {
    if (this.isListening) {
      this.logger.warn('HTM Center TV monitoring already started');
      return;
    }

    this.isListening = true;

    await this.loadInitialData();
    
  }

  private async loadInitialData() {
    try {
      // Load initial data for all factories and lines
      const factories = ['TS1', 'TS2', 'TS3'];
      const lines = ['1', '2', '3', '4'];

      for (const factory of factories) {
        for (const line of lines) {
          try {
            const data = await this.htmCenterTVService.getCenterTVData(factory, line);
            
            if (data.groups && data.groups.length > 0) {
              const key = `${factory}_${line}`;
              this.previousData.set(key, {
                ...data,
                checksum: this.calculateChecksum(data)
              });
              
            }
          } catch (error) {
            this.logger.warn(`Failed to load ${factory} LINE ${line}:`, error.message);
          }
        }
      }

    } catch (error) {
      this.logger.error('Failed to load initial HTM Center TV data:', error);
    }
  }

  // 🚀 CONFIGURABLE: Cron schedule via env variable to stagger checks across servers
  // TS1 (.env.ts1): HTM_CENTER_TV_CRON_SCHEDULE="0-58/2 7-21 * * 1-6" (even minutes)
  // TS2 (.env.ts2): HTM_CENTER_TV_CRON_SCHEDULE="1-59/2 7-21 * * 1-6" (odd minutes)
  // TS3 (.env.ts3): HTM_CENTER_TV_CRON_SCHEDULE="*/3 7-21 * * 1-6" (every 3 min)
  // Default: Every 2 minutes during work hours
  @Cron(process.env.HTM_CENTER_TV_CRON_SCHEDULE || '*/2 7-21 * * 1-6', {
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async checkForChanges() {
    if (!this.isListening) return;

    const vietnamTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"}));
    const timeStr = vietnamTime.toLocaleTimeString('vi-VN');
    
    if (!this.isInActiveProductionBlock(vietnamTime)) {
      return;
    }

    this.logger.log(`⏰ HTM Center TV: Cron triggered at ${timeStr} (2-minute staggered interval)`);

    try {
      const now = Date.now();
      if (this.lastCheckTime && (now - this.lastCheckTime) < 90000) { // Min 90 seconds
        return;
      }
      this.lastCheckTime = now;

      const factories = ['TS1', 'TS2', 'TS3'];
      const lines = ['1', '2', '3', '4'];
      const changes: Array<{ key: string; type: 'updated' | 'new'; data: any }> = [];

      for (const factory of factories) {
        for (const line of lines) {
          try {
            const currentData = await this.htmCenterTVService.getCenterTVData(factory, line);
            
            if (!currentData.groups || currentData.groups.length === 0) continue;

            const key = `${factory}_${line}`;
            const previousRecord = this.previousData.get(key);
            const currentChecksum = this.calculateChecksum(currentData);

            if (!previousRecord) {
              // New data
              changes.push({
                key,
                type: 'new',
                data: currentData
              });
              this.previousData.set(key, { ...currentData, checksum: currentChecksum });
            } else if (previousRecord.checksum !== currentChecksum) {
              // Updated data
              changes.push({
                key,
                type: 'updated',
                data: currentData
              });
              this.previousData.set(key, { ...currentData, checksum: currentChecksum });
            }
          } catch (error) {
            this.logger.warn(`Error checking ${factory} LINE ${line}:`, error.message);
          }
        }
      }

      if (changes.length > 0) {
        for (const change of changes) {
          this.emitChange(change);
        }
        
        this.websocketGateway.broadcastSystemUpdate('center-tv-refresh', {
          changesCount: changes.length,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      this.logger.error('❌ HTM Center TV: Error checking for changes:', error);
    }
  }

  private async emitChange(change: { key: string; type: string; data: any }) {
    const { key, type, data } = change;
    const [factory, line] = key.split('_');
    
    // Emit to specific factory-line subscribers
    const roomName = `center-tv-${factory.toLowerCase()}-${line}`;
    const roomSize = this.websocketGateway.server.sockets.adapter.rooms.get(roomName)?.size || 0;
    
      this.logger.log(`📡 HTM Center TV: Emitting ${type} to ${roomName} (${roomSize} clients) - Data has ${data.groups?.length || 0} groups`);
    
    this.websocketGateway.server.to(roomName).emit('center-tv-update', {
      factory,
      line,
      type,
      data: {
        groups: data.groups,
        summary: this.calculateSummaryFromGroups(data.groups)
      },
      timestamp: new Date().toISOString(),
      _debug: {
        sheetSource: 'HTM_CENTER_TV_DATA',
        updateTime: new Date().toLocaleTimeString('vi-VN')
      }
    });    if (roomSize === 0) {
      this.logger.warn(`⚠️ HTM Center TV: No clients in room ${roomName}`);
    }
  }

  private calculateSummaryFromGroups(groups: any[]): any {
    if (!groups || groups.length === 0) return {};

    // Calculate totals from 3 groups (Quai-Sơn-Lót)
    const summary = {
      totalLayout: 0,
      totalKeHoachNgay: 0,
      totalLkTh: 0,
      totalLkKh: 0,
      averagePhanTramHt: 0,
      groups: groups.map(g => ({
        nhom: g.nhom,
        layout: g.layout,
        keHoachNgay: g.keHoachNgay,
        lkTh: g.lkTh,
        phanTramHt: g.phanTramHt
      }))
    };

    groups.forEach(group => {
      summary.totalLayout += group.layout || 0;
      summary.totalKeHoachNgay += group.keHoachNgay || 0;
      summary.totalLkTh += group.lkTh || 0;
      summary.totalLkKh += group.lkKh || 0;
      summary.averagePhanTramHt += group.phanTramHt || 0;
    });

    summary.averagePhanTramHt = groups.length > 0 
      ? summary.averagePhanTramHt / groups.length 
      : 0;

    return summary;
  }

  private calculateChecksum(data: any): string {
    if (!data || !data.groups) return '';

    // Create checksum from all group data
    const groupsData = data.groups.map((g: any) => {
      const fields = [
        'nhom', 'layout', 'tglv', 'keHoachGio', 'keHoachNgay',
        'h830', 'h930', 'h1030', 'h1130', 'h1330', 'h1430', 'h1530', 'h1630', 'h1800', 'h1900', 'h2000',
        'soLuongGiaoMay', 'lkKh', 'lkTh', 'phanTramHt', 'bqTargetGio', 'sthd', 'slcl', 'tienDoApUng'
      ];
      
      return fields.map(f => String(g[f] || '')).join(',');
    }).join('|');

    return Buffer.from(groupsData).toString('base64');
  }

  private isInActiveProductionBlock(date: Date): boolean {
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    const activeBlocks = [
      "08:30", "09:30", "10:30", "11:30", "13:30", "14:30", 
      "15:30", "16:30", "18:00", "19:00", "20:00"
    ];

    return activeBlocks.some((block) => {
      const [h, m] = block.split(":").map(Number);
      const start = h * 60 + m;
      const end = start + 30;
      return nowMinutes >= start && nowMinutes < end;
    });
  }

  stopRealtimeMonitoring() {
    this.isListening = false;
    this.previousData.clear();
  }

  getMonitoringStats() {
    return {
      isListening: this.isListening,
      trackedCombinations: this.previousData.size,
      lastCheck: new Date().toISOString()
    };
  }
}