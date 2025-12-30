import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { TVDisplayMiddleware, TVDisplayRateLimitMiddleware } from './middleware/tv-display.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS for frontend and TV displays
  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3010',
      'https://live-chart-rho.vercel.app',
      'https://tvdisplay-ts1.vercel.app',
      'https://tvdisplay-ts2.vercel.app',
      /\.vercel\.app$/,
      // Add patterns for TV displays if needed
      /^http:\/\/192\.168\.\d+\.\d+:\d+$/, // Local network TVs
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control', 'Pragma'],
    // Optimize for TV displays
    maxAge: 86400, // 24 hours cache for preflight requests
  });


  // Apply TV Display middleware for monitoring and rate limiting
  const tvDisplayMiddleware = new TVDisplayMiddleware();
  const tvRateLimitMiddleware = new TVDisplayRateLimitMiddleware();
  
  app.use('/api/display/*', (req, res, next) => tvDisplayMiddleware.use(req, res, next));
  app.use('/api/display/*', (req, res, next) => tvRateLimitMiddleware.use(req, res, next));
  


  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
  }));

  // Global prefix for API routes
  app.setGlobalPrefix('api');

    // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('Live Chart Production API')
    .setDescription('Real-time production monitoring API for TV displays')
    .setVersion('1.0')
    .addTag('production', 'Production data endpoints')
    .addTag('display', 'TV display management')
    .addTag('websocket', 'Real-time WebSocket events')
    .addTag('health', 'Health check and monitoring')
    .addServer(`http://localhost:${process.env.PORT || 3001}`, 'Development server')
    .addServer('https://your-production-domain.com', 'Production server')
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 2,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'Live Chart API Documentation',
    customfavIcon: 'https://nestjs.com/img/logo_text.svg',
    customJs: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-standalone-preset.min.js',
    ],
    customCssUrl: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css',
    ],
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`🚀 Backend server running on port ${port}`);
  console.log(`📚 API Documentation available at http://localhost:${port}/api/docs`);
  console.log(`🔍 Health Check: http://localhost:${port}/api/production/health`);
}
bootstrap();