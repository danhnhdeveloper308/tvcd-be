# QSL Module (QUAI, SƠN, LÓT)

Module phục vụ nghiệp vụ QSL - đọc dữ liệu từ Google Sheets LINE1, LINE2, LINE3, LINE4...

## 📊 Cấu trúc dữ liệu

### Google Sheets Structure
- **Range**: A1:T90
- **Sheets**: LINE1, LINE2, LINE3, LINE4...

### Columns (A-T)
| Cột | Tên cột | Mô tả |
|-----|---------|-------|
| **A** | TÊN TỔ | Tên tổ (TỔ 1, TỔ 2, hoặc trống nếu là dòng TÚI NHỎ) |
| **B** | TGLV | Thời gian làm việc (số nhóm), HOẶC "TÚI NHỎ (NẾU CÓ)" |
| **C** | NHÓM | Tên nhóm công việc |
| **D** | LĐ LAYOUT | Lao động layout |
| **E** | THỰC TẾ | Lao động thực tế |
| **F** | KẾ HOẠCH | Kế hoạch sản xuất |
| **G** | 8H30 | Sản lượng giờ 8h30 |
| **H** | 9H30 | Sản lượng giờ 9h30 |
| **I** | 10H30 | Sản lượng giờ 10h30 |
| **J** | 11H30 | Sản lượng giờ 11h30 |
| **K** | 13H30 | Sản lượng giờ 13h30 |
| **L** | 14H30 | Sản lượng giờ 14h30 |
| **M** | 15H30 | Sản lượng giờ 15h30 |
| **N** | 16H30 | Sản lượng giờ 16h30 |
| **O** | 18H | Sản lượng giờ 18h |
| **P** | 19H | Sản lượng giờ 19h |
| **Q** | 20H | Sản lượng giờ 20h |
| **R** | LUỸ KẾ THỰC HIỆN | Tổng lũy kế đã thực hiện |
| **S** | LUỸ KẾ KẾ HOẠCH | Tổng lũy kế kế hoạch |
| **T** | %HT | Phần trăm hoàn thành |

### Data Logic

Mỗi TỔ có cấu trúc:
- **9 dòng cố định** (luôn có):
  1. ĐỒNG GÓI
  2. QC KIỂM TÚI
  3. SƠN TP
  4. RÁP
  5. THÂN
  6. LÓT
  7. QC KIỂM QUAI
  8. QUAI
  9. SƠN CT/BTP

- **Tối đa 8 dòng TÚI NHỎ** (nếu có):
  - **8 nhóm**: QC KIỂM TÚI, SƠN TP, RÁP, THÂN, LÓT, QC KIỂM QUAI, QUAI, SƠN CT/BTP (không có ĐÓNG GÓI)
  - Chỉ return các dòng có **KẾ HOẠCH (cột F) > 0**
  - **Hỗ trợ nhiều format tên**: "TÚI NHỎ", "TÚI NHỎ(NẾU CÓ)", "Túi nhỏ", v.v.
  - **TÚI NHỎ marker có thể nằm ở cột A HOẶC cột B**
  - **Tất cả rows sau marker "TÚI NHỎ"** (cho đến TỔ mới) đều thuộc TÚI NHỎ section
  - Regex match: `/^TÚI\s+NHỎ/i` (case-insensitive, bắt đầu bằng "TÚI NHỎ")

## 🚀 API Endpoints

### 1. GET /api/display/qsl
Lấy dữ liệu QSL theo line number

**Query Parameters:**
- `line` (required): Line number (1, 2, 3, 4...)

**Examples:**
```bash
GET /api/display/qsl?line=1
GET /api/display/qsl?line=2
GET /api/display/qsl?line=3
GET /api/display/qsl?line=4
```

**Response:**
```json
{
  "success": true,
  "data": {
    "line": 1,
    "sheetName": "LINE1",
    "totalTeams": 2,
    "teams": [
      {
        "tenTo": "TỔ 1",
        "tglv": 11,
        "fixedGroups": [
          {
            "nhom": "ĐỒNG GÓI",
            "ldLayout": 7,
            "thucTe": 8,
            "keHoach": 50,
            "hourly": {
              "h8h30": 43,
              "h9h30": 43,
              "h10h30": 43,
              // ... other hours
            },
            "luyKeThucHien": 473,
            "luyKeKeHoach": 550,
            "percentHT": 86
          },
          // ... 7 more fixed groups
        ],
        "tuiNhoGroups": [
          {
            "nhom": "QC KIỂM TÚI",
            "ldLayout": 0,
            "thucTe": 0,
            "keHoach": 50,
            // ... other fields
          }
          // ... more TÚI NHỎ groups if applicable
        ]
      }
    ],
    "lastUpdate": "2026-01-15T10:30:00.000Z"
  },
  "timestamp": "2026-01-15T10:30:00.000Z"
}
```

### 2. POST /api/display/qsl/check-changes
Trigger manual check for changes (testing)

**Example:**
```bash
POST /api/display/qsl/check-changes
```

**Response:**
```json
{
  "success": true,
  "message": "QSL sheets check completed",
  "stats": {
    "isListening": true,
    "monitoredLines": [1, 2, 3, 4],
    "trackedLines": 4,
    "lastCheckTime": "2026-01-15T10:30:00.000Z"
  },
  "timestamp": "2026-01-15T10:30:00.000Z"
}
```

## 🔌 WebSocket Events

### Subscribe to QSL updates

**Event**: `subscribe-qsl`

**Payload:**
```javascript
socket.emit('subscribe-qsl', { line: 1 });
```

**Confirmation:**
```javascript
socket.on('qsl-subscription-confirmed', (data) => {
  console.log(data);
  // {
  //   roomName: 'qsl-line1',
  //   line: 1,
  //   roomSize: 1,
  //   timestamp: '2026-01-15T10:30:00.000Z',
  //   message: 'QSL subscription confirmed for LINE1'
  // }
});
```

### Receive updates

**Event**: `qsl-update`

```javascript
socket.on('qsl-update', (update) => {
  console.log(update);
  // {
  //   line: 1,
  //   type: 'updated', // 'new', 'updated'
  //   data: { ... full data structure ... },
  //   changes: {
  //     teamsAdded: [],
  //     teamsRemoved: [],
  //     teamsModified: ['TỔ 1']
  //   },
  //   timestamp: '2026-01-15T10:30:00.000Z'
  // }
});
```

## ⚙️ Configuration

### Environment Variables

```env
# QSL Cron Schedule (default: every 2 minutes, 7AM-9PM, Mon-Sat)
QSL_CRON_SCHEDULE="*/2 7-21 * * 1-6"
```

### Monitored Lines

Edit `qsl-listener.service.ts` to change monitored lines:

```typescript
private readonly MONITORED_LINES = [1, 2, 3, 4]; // LINE1, LINE2, LINE3, LINE4
```

## 🔧 Services

### QSLSheetsService
- `getProductionDataByLine(line: number)` - Lấy dữ liệu theo line number
- `clearCache(line?: number)` - Clear cache

### QSLListenerService
- `startRealtimeMonitoring()` - Bắt đầu monitoring
- `stopRealtimeMonitoring()` - Dừng monitoring
- `manualCheckForChanges()` - Manual trigger
- `getMonitoringStats()` - Lấy thống kê

## 📝 Notes

- **Cache TTL**: 15 seconds
- **Cron Schedule**: Every 2 minutes during work hours (7AM-9PM, Mon-Sat)
- **Request Throttling**: 100ms between Google Sheets API calls
- **Active Hours**: 7AM - 9PM (Vietnam time)

## 🧪 Testing

```bash
# Test API endpoint
curl "http://localhost:3001/api/display/qsl?line=1"

# Trigger manual check
curl -X POST "http://localhost:3001/api/display/qsl/check-changes"

# WebSocket test (from browser console)
const socket = io('http://localhost:3001');
socket.emit('subscribe-qsl', { line: 1 });
socket.on('qsl-update', (data) => console.log('QSL Update:', data));
```
