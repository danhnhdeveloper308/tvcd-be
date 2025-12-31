import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleSheetsService } from './google-sheets.service';
import { CDProductSheetsService } from './cd/cd-product-sheets.service';
import { CDProductListenerService } from './cd/cd-product-listener.service';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [ConfigModule, forwardRef(() => WebsocketModule)],
  providers: [
    GoogleSheetsService,
    CDProductSheetsService,
    CDProductListenerService,
  ],
  exports: [
    GoogleSheetsService,
    CDProductSheetsService,
    CDProductListenerService,
  ],
})
export class GoogleSheetsModule {}
