# Live Chart Backend API

Backend NestJS tối ưu hóa cho hệ thống giám sát sản xuất thời gian thực dành cho TV displays.

## 🚀 Tính năng chính

- **Real-time data**: Cập nhật dữ liệu sản xuất mỗi 5 phút
- **TV Display Optimization**: API tối ưu cho từng màn hình TV riêng biệt
- **Smart Caching**: Cache thông minh theo factory/line/team
- **WebSocket Support**: Kết nối real-time cho cập nhật tức thời
- **Performance Monitoring**: Theo dõi hiệu suất và tối ưu hóa tự động
- **📚 Swagger Documentation**: Interactive API documentation và testing

## 📡 API Endpoints

### Production Data APIs

#### 1. Lấy dữ liệu sản xuất (Query Parameters)
```
GET /api/production/data
Query: ?factory=TS1&line=1&team=2
```

#### 2. Lấy dữ liệu sản xuất (URL Path - Tối ưu cho TV)
```
GET /api/production/live/:factory/:line/:team
Ví dụ: /api/production/live/TS1/1/2
```

#### 3. Tóm tắt dữ liệu sản xuất
```
GET /api/production/summary
Query: ?factory=TS1&line=1
```

#### 4. Metadata (Danh sách factories, lines, teams)
```
GET /api/production/metadata
```

#### 5. Làm mới dữ liệu thủ công
```
POST /api/production/refresh
Query: ?factory=TS1 (optional)
```

#### 6. Health Check
```
GET /api/production/health
```

### TV Display APIs

#### 1. URL chính cho TV displays
```
GET /api/display/factory=TS1/line=1/team=2
GET /api/display/factory=TS1/line=1
GET /api/display/factory=TS1
```

#### 2. Cấu hình màn hình
```
GET /api/display/config/:displayId
POST /api/display/config/:displayId
Body: {
  "refreshInterval": 300000,
  "layout": "detailed",
  "showMetrics": ["targetDay", "lkth", "hitSLTH"]
}
```

#### 3. Danh sách màn hình đang hoạt động
```
GET /api/display/active
```

#### 4. Tạo URL cho màn hình
```
POST /api/display/generate-url
Body: {
  "factory": "TS1",
  "line": "1",
  "team": "2"
}
```

#### 5. Thống kê màn hình
```
GET /api/display/stats
```

#### 6. Tối ưu hóa refresh interval
```
POST /api/display/optimize-intervals
```

### TV Display System - Live Production Monitoring

Hệ thống được thiết kế tối ưu cho TV displays với **chỉ 1 API endpoint** cần thiết:

```
GET /api/display/tv?code=KVHB07M01
```

## 📋 Cách sử dụng

### 1. TV Display URL
```bash
# Thay KVHB07M01 bằng mã chuyền cụ thể
curl "http://localhost:3001/api/display/tv?code=KVHB07M01"
```

### 2. Response Format
```json
{
  "success": true,
  "code": "KVHB07M01",
  "data": {
    "maChuyenLine": "KVHB07M01",
    "factory": "TS1",
    "line": "1",
    "team": "1",
    "maHang": "KM218",
    "metrics": {
      "slth": 74,
      "targetNgay": 352,
      "hitSLTH": 67,
      "pphTh": 0,
      "hitPPH": 0,
      "ldCoMat": 91,
      "nangSuat": 3.51,
      "rft": 0,
      "tongKiem": 165
    },
    "hourlyData": {
      "hourly": {
        "h8h30": 0,
        "h9h30": 0,
        "h10h30": 0
      },
      "cumulative": {
        "h8h30": 0,
        "h9h30": 0,
        "h10h30": 0
      },
      "total": 0,
      "latest": {
        "hour": "h8h30",
        "value": 0
      }
    },
    "image": "https://drive.google.com/thumbnail?id=...",
    "lastUpdate": "2024-01-01T10:30:00.000Z"
  },
  "timestamp": "2024-01-01T10:30:00.000Z",
  "cached": true
}
```

### 3. Real-time Updates (WebSocket)
```javascript
// Frontend code
const socket = io('http://localhost:3001');

// Subscribe to specific production line
socket.emit('subscribe-production', { 
  maChuyenLine: 'KVHB07M01' 
});

// Listen for updates
socket.on('production-update', (data) => {
  console.log('New data:', data);
  // Update TV display
});
```

## 🏭 Mã chuyền theo Factory

| Factory | Mã chuyền Range | Ví dụ |
|---------|----------------|-------|
| **TS1** | KVHB07M01 - KVHB07M14 | KVHB07M01, KVHB07M07 |
| **TS2** | KVHB07M18 - KVHB07M24 | KVHB07M18, KVHB07M22 |
| **TS3** | KVHB07M25 - KVHB07M38 | KVHB07M25, KVHB07M30 |

## ⚡ Performance Features

- **Ultra-fast Cache**: In-memory + Redis dual cache
- **Real-time Updates**: WebSocket với 30-second intervals
- **TV Optimized**: Response time < 100ms
- **Auto Refresh**: Frontend chỉ cần poll endpoint này

## 🔧 Development

### Start Backend
```bash
npm run start:dev
```

### Test System
```bash
node demo-tv-system.js
```

### API Documentation
```
http://localhost:3001/api/docs
```

## 📊 TV Display URLs

```bash
# TS1 Factory
http://localhost:3001/api/display/tv?code=KVHB07M01
http://localhost:3001/api/display/tv?code=KVHB07M07

# TS2 Factory  
http://localhost:3001/api/display/tv?code=KVHB07M18
http://localhost:3001/api/display/tv?code=KVHB07M22

# TS3 Factory
http://localhost:3001/api/display/tv?code=KVHB07M25
http://localhost:3001/api/display/tv?code=KVHB07M30
```

## 🎯 Key Features

✅ **Single Endpoint** - Chỉ 1 API cho tất cả TV displays  
✅ **Real-time Updates** - WebSocket auto-push changes  
✅ **Ultra-fast Cache** - Response < 100ms  
✅ **Google Sheets Integration** - Tự động sync từ Google Sheets  
✅ **Column A-AS Support** - Đầy đủ dữ liệu sản xuất  
✅ **Factory Auto-detect** - Tự động phát hiện factory từ mã chuyền  

---

**Đơn giản vậy thôi! Frontend chỉ cần gọi 1 endpoint và lắng nghe WebSocket updates.**