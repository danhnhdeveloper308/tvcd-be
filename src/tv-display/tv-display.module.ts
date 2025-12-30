import { Module } from '@nestjs/common';
import { DisplayRouterController } from './display-router.controller';
import { WebsocketModule } from '../websocket/websocket.module';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';

@Module({
  imports: [
    WebsocketModule,
    GoogleSheetsModule, // Import to access HTMSheetsService, CDSheetsService, etc.
  ],
  controllers: [
    DisplayRouterController  // Smart router controller (handles HTM, CD, Center TV)
  ],
  providers: [],
  exports: [],
})
export class TVDisplayModule {}