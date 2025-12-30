import { Module, forwardRef } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';

@Module({
  imports: [forwardRef(() => GoogleSheetsModule)],
  providers: [WebsocketGateway],
  exports: [WebsocketGateway],
})
export class WebsocketModule {}