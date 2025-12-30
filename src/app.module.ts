import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { WebsocketModule } from './websocket/websocket.module';
import { TVDisplayModule } from './tv-display/tv-display.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    CacheModule.register({
      isGlobal: true,
      ttl: 300, // 5 minutes cache
      max: 100,
    }),
    WebsocketModule,
    TVDisplayModule,
  ],
})
export class AppModule {}