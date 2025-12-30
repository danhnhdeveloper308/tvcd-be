import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleSheetsService } from './google-sheets.service';
import { HTMSheetsService } from './htm/htm-sheets.service';
import { HTMSheetsListenerService } from './htm/htm-sheets-listener.service';
import { CDProductSheetsService } from './cd/cd-product-sheets.service';
import { CDProductListenerService } from './cd/cd-product-listener.service';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [ConfigModule, forwardRef(() => WebsocketModule)],
  providers: [
    GoogleSheetsService,
    HTMSheetsService,
    HTMSheetsListenerService,
    CDProductSheetsService,
    CDProductListenerService,
  ],
  exports: [
    GoogleSheetsService,
    HTMSheetsService,
    HTMSheetsListenerService,
    CDProductSheetsService,
    CDProductListenerService,
  ],
})
export class GoogleSheetsModule {}
