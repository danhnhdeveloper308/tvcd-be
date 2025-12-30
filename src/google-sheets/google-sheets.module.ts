import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleSheetsService } from './google-sheets.service';
import { HTMSheetsService } from './htm/htm-sheets.service';
import { HTMCenterTVService } from './htm/htm-center-tv.service';
import { HTMSheetsListenerService } from './htm/htm-sheets-listener.service';
import { CDSheetsService } from './cd/cd-sheets.service';
import { CDProductSheetsService } from './cd/cd-product-sheets.service';
import { CDProductListenerService } from './cd/cd-product-listener.service';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [ConfigModule, forwardRef(() => WebsocketModule)],
  providers: [
    GoogleSheetsService,
    HTMSheetsService,
    HTMCenterTVService,
    HTMSheetsListenerService,
    CDSheetsService,
    CDProductSheetsService,
    CDProductListenerService,
  ],
  exports: [
    GoogleSheetsService,
    HTMSheetsService,
    HTMCenterTVService,
    HTMSheetsListenerService,
    CDSheetsService,
    CDProductSheetsService,
    CDProductListenerService,
  ],
})
export class GoogleSheetsModule {}
