import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GoogleSheetsService } from "./google-sheets.service";
import { CDProductSheetsService } from "./cd/cd-product-sheets.service";
import { CDProductListenerService } from "./cd/cd-product-listener.service";
import { WebsocketModule } from "../websocket/websocket.module";
// import { QSLSheetsService } from "./qsl/qsl-sheets.service";
// import { QSLListenerService } from "./qsl/qsl-listener.service";

@Module({
  imports: [ConfigModule, forwardRef(() => WebsocketModule)],
  providers: [
    GoogleSheetsService,
    CDProductSheetsService,
    CDProductListenerService,
    // QSLSheetsService,
    // QSLListenerService,
  ],
  exports: [
    GoogleSheetsService,
    CDProductSheetsService,
    CDProductListenerService,
    // QSLSheetsService,
    // QSLListenerService,
  ],
})
export class GoogleSheetsModule {}
