import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3000', 'https://live-chart-rho.vercel.app'],
    credentials: true,
  },
})
export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);
  private connectedClients = new Map<string, { socket: Socket; subscriptions: string[] }>();

  constructor(
  ) {}

  handleConnection(client: Socket) {
    this.connectedClients.set(client.id, { socket: client, subscriptions: [] });

    // Send welcome message
    client.emit('connection-established', {
      clientId: client.id,
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket) {
    this.connectedClients.delete(client.id);
  }

  /**
   * ⭐ NEW: Subscribe to CD Product updates (CD1, CD2, CD3, CD4)
   */
  @SubscribeMessage('subscribe-cd-product')
  handleSubscribeCDProduct(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    const sheetCode = data.code.toUpperCase(); // CD1, CD2, CD3, CD4
    const roomName = `cd-product-${sheetCode.toLowerCase()}`;

    const clientData = this.connectedClients.get(client.id);
    if (clientData && !clientData.subscriptions.includes(roomName)) {
      clientData.subscriptions.push(roomName);
    }

    // Join the room
    client.join(roomName);

    // Get room size
    const roomSize = this.server.sockets.adapter.rooms.get(roomName)?.size || 0;

    // Send confirmation
    client.emit('cd-product-subscription-confirmed', {
      roomName,
      sheetCode,
      roomSize,
      timestamp: new Date().toISOString(),
      message: 'CD Product subscription confirmed',
    });

    this.logger.log(
      `✅ Client ${client.id} subscribed to ${roomName} for sheet ${sheetCode} (${roomSize} clients in room)`,
    );
  }

  /**
   * ⭐ NEW: Subscribe to QSL updates (LINE1, LINE2, LINE3, LINE4...)
   */
  // @SubscribeMessage('subscribe-qsl')
  // handleSubscribeQSL(
  //   @MessageBody() data: { line: number },
  //   @ConnectedSocket() client: Socket,
  // ) {
  //   const lineNumber = data.line; // 1, 2, 3, 4...
  //   const roomName = `qsl-line${lineNumber}`;

  //   const clientData = this.connectedClients.get(client.id);
  //   if (clientData && !clientData.subscriptions.includes(roomName)) {
  //     clientData.subscriptions.push(roomName);
  //   }

  //   // Join the room
  //   client.join(roomName);

  //   // Get room size
  //   const roomSize = this.server.sockets.adapter.rooms.get(roomName)?.size || 0;

  //   // Send confirmation
  //   client.emit('qsl-subscription-confirmed', {
  //     roomName,
  //     line: lineNumber,
  //     roomSize,
  //     timestamp: new Date().toISOString(),
  //     message: `QSL subscription confirmed for LINE${lineNumber}`,
  //   });

  //   this.logger.log(
  //     `✅ Client ${client.id} subscribed to ${roomName} for LINE${lineNumber} (${roomSize} clients in room)`,
  //   );
  // }

  @SubscribeMessage('unsubscribe-production')
  handleUnsubscribeProduction(
    @MessageBody() data: { factory?: string; line?: string; team?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const subscriptionKey = `production:${data.factory || 'all'}:${data.line || 'all'}:${data.team || 'all'}`;

    const clientData = this.connectedClients.get(client.id);
    if (clientData) {
      clientData.subscriptions = clientData.subscriptions.filter(sub => sub !== subscriptionKey);
    }

    client.leave(subscriptionKey);
  }

  emitProductionUpdate(factory: string, data: any) {
    const roomKey = `production:${factory}:all:all`;
    this.server.to(roomKey).emit('production-update', {
      factory,
      data,
      timestamp: new Date().toISOString(),
    });

    // Also emit to specific line/team rooms if they exist
    this.server.sockets.adapter.rooms.forEach((sockets, room) => {
      if (room.startsWith(`production:${factory}:`) && room !== roomKey) {
        this.server.to(room).emit('production-update', {
          factory,
          data,
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  emitSystemAlert(message: string, level: 'info' | 'warning' | 'error' = 'info') {
    this.server.emit('system-alert', {
      message,
      level,
      timestamp: new Date().toISOString(),
    });
  }

  getConnectedClientsCount(): number {
    return this.connectedClients.size;
  }

  getSubscriptionStats(): any {
    const stats: { [key: string]: number } = {};

    this.server.sockets.adapter.rooms.forEach((sockets, room) => {
      if (room.startsWith('production:')) {
        stats[room] = sockets.size;
      }
    });

    return stats;
  }

  // Send immediate data when client subscribes
  private async sendImmediateData(client: Socket, subscription: any) {
    try {
      // This would be called from ProductionService to send current data
      client.emit('production-immediate', {
        message: 'Subscription confirmed',
        subscription: subscription,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Failed to send immediate data:', error);
    }
  }

  // Emit update for specific maChuyenLine (TV displays)
  emitMaChuyenLineUpdate(maChuyenLine: string, data: any) {
    const subscriptionKey = `production:code:${maChuyenLine}`;
    const roomSize = this.server.sockets.adapter.rooms.get(subscriptionKey)?.size || 0;

    this.logger.log(`📡 WebSocket: Emitting to ${subscriptionKey} (${roomSize} clients)`);

    // ✅ 1. Emit to room-based subscription (for joined clients)
    if (roomSize > 0) {
      const payload = {
        maChuyenLine,
        ...data,
        timestamp: new Date().toISOString(),
      };

      // Log payload summary for debugging
      this.logger.debug(
        `📦 Payload summary: type=${data.data?.type}, slth=${data.data?.summary?.slth}, tongKiem=${data.data?.summary?.tongKiem}`,
      );

      this.server.to(subscriptionKey).emit('production-update', payload);
      this.logger.log(`✅ WebSocket: Emitted production-update to ${roomSize} client(s)`);
    } else {
      this.logger.warn(`⚠️ WebSocket: No clients in room ${subscriptionKey}`);
    }

    // ✅ 2. For CD lines, ALSO broadcast to ALL clients (fallback)
    if (maChuyenLine.includes('CD')) {
      const cdChannel = `cd:${maChuyenLine}`;

      this.server.emit(cdChannel, {
        maChuyenLine,
        lineType: 'CD',
        ...data,
        timestamp: new Date().toISOString(),
      });
    }

    // ✅ 3. Also emit to factory subscription
    const factory = this.extractFactoryFromMaChuyenLine(maChuyenLine);
    if (factory) {
      const factoryKey = `production:${factory}:all:all`;
      const factoryRoomSize = this.server.sockets.adapter.rooms.get(factoryKey)?.size || 0;

      if (factoryRoomSize > 0) {
        this.server.to(factoryKey).emit('production-update', {
          maChuyenLine,
          factory,
          ...data,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Broadcast to all connected clients (system-wide updates)
  broadcastSystemUpdate(updateType: string, data: any) {
    this.server.emit('system-update', {
      type: updateType,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  // Helper method to extract factory from maChuyenLine - flexible for any code format
  private extractFactoryFromMaChuyenLine(maChuyenLine: string): string | null {
    if (!maChuyenLine) {
      return null;
    }

    // Try KVHB07M format first
    if (maChuyenLine.startsWith('KVHB07M')) {
      const match = maChuyenLine.match(/KVHB07M(\d+)/);
      if (match) {
        const lineNumber = parseInt(match[1]);

        if (lineNumber >= 1 && lineNumber <= 14) {
          return 'TS1';
        } else if (lineNumber >= 18 && lineNumber <= 24) {
          return 'TS2';
        } else if (lineNumber >= 25 && lineNumber <= 38) {
          return 'TS3';
        }
      }
    }

    // Try KV format (KV1111 -> extract last 2 digits)
    const kvMatch = maChuyenLine.match(/^KV(\d+)/);
    if (kvMatch) {
      const number = parseInt(kvMatch[1]);
      const lineNumber = number % 100; // Get last 2 digits

      if (lineNumber >= 1 && lineNumber <= 14) {
        return 'TS1';
      } else if (lineNumber >= 18 && lineNumber <= 24) {
        return 'TS2';
      } else if (lineNumber >= 25 && lineNumber <= 38) {
        return 'TS3';
      }
    }

    // For any other format, return default factory or null
    return null;
  }
}
