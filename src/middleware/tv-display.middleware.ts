import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class TVDisplayMiddleware implements NestMiddleware {
  private readonly logger = new Logger('TVDisplayMiddleware');

  use(req: Request, res: Response, next: NextFunction) {
    const startTime = Date.now();
    const { method, originalUrl, ip } = req;
    const userAgent = req.get('User-Agent') || '';

    // Log TV display requests
    // if (originalUrl.startsWith('/api/display/')) {
      
    //   // Track TV-specific metrics
    //   const displayPath = originalUrl.replace('/api/display/', '');
    //   this.logger.debug(`Display Path: ${displayPath}, User-Agent: ${userAgent}`);
    // }

    // Add response timing
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const { statusCode } = res;
      
      if (originalUrl.startsWith('/api/display/')) {
      }
    });

    next();
  }
}

// Rate limiting middleware specifically for TV displays
@Injectable()
export class TVDisplayRateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger('TVDisplayRateLimit');
  private requestCounts = new Map<string, { count: number; resetTime: number }>();
  private readonly RATE_LIMIT = 2000; // requests per window
  private readonly WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  use(req: Request, res: Response, next: NextFunction) {
    if (!req.originalUrl.startsWith('/api/display/')) {
      return next();
    }

    const clientId = this.getClientId(req);
    const now = Date.now();
    
    // Clean old entries
    this.cleanOldEntries(now);
    
    const clientData = this.requestCounts.get(clientId) || { count: 0, resetTime: now + this.WINDOW_MS };
    
    if (now > clientData.resetTime) {
      // Reset window
      clientData.count = 1;
      clientData.resetTime = now + this.WINDOW_MS;
    } else {
      clientData.count++;
    }
    
    this.requestCounts.set(clientId, clientData);
    
    if (clientData.count > this.RATE_LIMIT) {
      this.logger.warn(`Rate limit exceeded for TV display client: ${clientId}`);
      return res.status(429).json({
        success: false,
        error: 'Too many requests from TV display',
        retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
      });
    }
    
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', this.RATE_LIMIT);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, this.RATE_LIMIT - clientData.count));
    res.setHeader('X-RateLimit-Reset', new Date(clientData.resetTime).toISOString());
    
    next();
  }

  private getClientId(req: Request): string {
    // Use IP + User-Agent for TV identification
    const ip = req.ip || req.connection.remoteAddress || '';
    const userAgent = req.get('User-Agent') || '';
    return `${ip}:${userAgent.substring(0, 50)}`;
  }

  private cleanOldEntries(now: number) {
    for (const [clientId, data] of this.requestCounts.entries()) {
      if (now > data.resetTime) {
        this.requestCounts.delete(clientId);
      }
    }
  }

  // Get rate limit statistics
  getStats() {
    const now = Date.now();
    const activeClients = Array.from(this.requestCounts.entries())
      .filter(([, data]) => now <= data.resetTime)
      .map(([clientId, data]) => ({
        clientId: clientId.substring(0, 20) + '...',
        requests: data.count,
        resetAt: new Date(data.resetTime).toISOString()
      }));

    return {
      activeClients: activeClients.length,
      totalRequests: activeClients.reduce((sum, client) => sum + client.requests, 0),
      clients: activeClients
    };
  }
}