# 📊 ENDLINE RFT Data Implementation Guide

## 🎯 Overview

Hệ thống đã được cập nhật để sử dụng **2 sheets ENDLINE** mới thay thế cho sheet `DATA_RFT` cũ:

1. **ENDLINE_BEFORE_DATA** - Dữ liệu từ 0h đến 8:30 sáng
2. **ENDLINE_DAILY_DATA** - Dữ liệu sau 8:30 sáng

---

## 📋 Sheet Structure

### Column Mapping (A-AJ)

| Column | Name | Description | Data Type |
|--------|------|-------------|-----------|
| A | NM | Nhà máy (TS1, TS2, TS3) | String |
| B | LINE | Số line (1, 2, 3...) | String |
| C | 16 | - | Number |
| D | 1 | - | Number |
| E | TỔ | Tổ (Tổ 1, Tổ 2...) | String |
| F | TỔNG KIỂM | Tổng số kiểm tra | Number |
| G | ĐẠT LẦN 1 | Số đạt lần đầu | Number |
| H | TỔNG ĐẠT | Tổng số đạt | Number |
| I | DÍNH KEO | Lỗi 1 | Number |
| J | LỖ KIM | Lỗi 2 | Number |
| K | LỖI ĐƯỜNG MAY | Lỗi 3 | Number |
| L | LỖI DA | Lỗi 4 | Number |
| M | MÀU VÂN KHÔNG ĐỒNG BỘ | Lỗi 5 | Number |
| N | LỖI HW | Lỗi 6 | Number |
| O | DÂY KÉO GỢN SÓNG | Lỗi 7 | Number |
| P | LEM SƠN BIÊN | Lỗi 8 | Number |
| Q | CHI TIẾT NHĂN VÀ GẤP NẾP | Lỗi 9 | Number |
| R | LOGO NGHIÊNG XÉO | Lỗi 10 | Number |
| S | ÉP MỜ | Lỗi 11 | Number |
| T | CHI TIẾT KHÔNG THẲNG HÀNG | Lỗi 12 | Number |
| U | LỖI DÁNG | Lỗi 13 | Number |
| V | LỖI KHÁC | Lỗi 14 | Number |
| W | RFT | RFT % | Percentage |
| X | 8H30 | Sản lượng 8h30 | Number |
| Y | 9H30 | Sản lượng 9h30 | Number |
| Z | 10H30 | Sản lượng 10h30 | Number |
| AA | 11H30 | Sản lượng 11h30 | Number |
| AB | 13H30 | Sản lượng 13h30 | Number |
| AC | 14H30 | Sản lượng 14h30 | Number |
| AD | 15H30 | Sản lượng 15h30 | Number |
| AE | 16H30 | Sản lượng 16h30 | Number |
| AF | 18H00 | Sản lượng 18h00 | Number |
| AG | 19H00 | Sản lượng 19h00 | Number |
| AH | 20H00 | Sản lượng 20h00 | Number |
| AI | DỮ LIỆU | - | String |
| AJ | NGUYÊN NHÂN | - | String |

---

## ⏰ Time-based Sheet Selection

### Logic Flow

```typescript
Current Time < 8:30 AM
  ↓
Use: ENDLINE_BEFORE_DATA
  ↓
Get yesterday's final data

Current Time >= 8:30 AM
  ↓
Use: ENDLINE_DAILY_DATA
  ↓
Get today's real-time data
```

### Implementation

```typescript
// Check Vietnam time
const vietnamTime = new Date(new Date().toLocaleString("en-US", {
  timeZone: "Asia/Ho_Chi_Minh"
}));

const currentHour = vietnamTime.getHours();
const currentMinute = vietnamTime.getMinutes();
const currentTimeInMinutes = currentHour * 60 + currentMinute;

// 8:30 AM cutoff
const isBefore830 = currentTimeInMinutes < 510;

const sheetName = isBefore830 
  ? 'ENDLINE_BEFORE_DATA' 
  : 'ENDLINE_DAILY_DATA';
```

---

## 🏭 Factory-specific Ranges

### Environment Variables

```bash
# TS1 Factory
ENDLINE_BEFORE_TS1_RANGE="A1:AJ12"
ENDLINE_DAILY_TS1_RANGE="A1:AJ12"

# TS2 Factory
ENDLINE_BEFORE_TS2_RANGE="A13:AJ24"
ENDLINE_DAILY_TS2_RANGE="A13:AJ24"

# TS3 Factory
ENDLINE_BEFORE_TS3_RANGE="A25:AJ36"
ENDLINE_DAILY_TS3_RANGE="A25:AJ36"

# All Factories (default)
ENDLINE_BEFORE_ALL_RANGE="A1:AJ50"
ENDLINE_DAILY_ALL_RANGE="A1:AJ50"
```

### Range Distribution

| Factory | Rows | Lines | Teams per Line |
|---------|------|-------|----------------|
| TS1 | 1-12 | 4 lines | 3 teams each |
| TS2 | 13-24 | 4 lines | 3 teams each |
| TS3 | 25-36 | 4 lines | 3 teams each |

---

## 🔍 Team Filtering (Index Parameter)

### API Usage

```bash
# Without team filter (all teams)
GET /api/display/tv?code=KVHB07M01

# With team filter (Tổ 1 only, index=0)
GET /api/display/tv?code=KVHB07M01&index=0

# Tổ 2 (index=1)
GET /api/display/tv?code=KVHB07M01&index=1

# Tổ 3 (index=2)
GET /api/display/tv?code=KVHB07M01&index=2
```

### Index Mapping

| Index | Team Name | Description |
|-------|-----------|-------------|
| 0 | Tổ 1 | First team |
| 1 | Tổ 2 | Second team |
| 2 | Tổ 3 | Third team |

### Frontend Implementation

```typescript
// Example: TV display for Line M10, Team 1
const tvUrl = `${API_URL}/api/display/tv?code=KVHB07M10&factory=TS1&index=0`;

// Fetch data
const response = await fetch(tvUrl);
const data = await response.json();

console.log(data.teamIndex); // 0
console.log(data.data.to); // "Tổ 1"
```

---

## 📊 Data Processing Logic

### Key Changes

#### ✅ **No Calculation Required**
- Data is already **SUM** (cumulative) in sheets
- Just read and display values directly

#### ✅ **Hourly Data** (Columns X-AH)
- Contains production numbers per time slot
- Already calculated in sheets

#### ✅ **Error Tracking** (Columns I-V)
- 14 error types already summed
- No need to recalculate percentages

### Code Example

```typescript
// Parse ENDLINE row
const tongKiem = row[5];    // Column F - Already cumulative
const datLan1 = row[6];     // Column G - Already cumulative  
const tongDat = row[7];     // Column H - Already cumulative
const rft = row[22];        // Column W - Final RFT %

// Parse errors (already summed)
const loi1 = row[8];   // I: DÍNH KEO
const loi2 = row[9];   // J: LỖ KIM
// ... loi3 to loi14

// Parse hourly data (columns X-AH)
const h830 = row[23];   // Column X
const h930 = row[24];   // Column Y
// ... rest of time slots

// ✅ NO calculation needed - use values directly!
```

---

## 🔄 Migration from Old DATA_RFT

### Old Structure (DATA_RFT)
```
Row: maChuyenLine
Columns: Time slots with 18 columns each
- RFT, TongKiem, DatLan1, TongDat, Loi1-14
- Need to calculate cumulative values
```

### New Structure (ENDLINE sheets)
```
Row: NM + LINE + TỔ
Columns: Separate error columns + time slots
- All values pre-calculated (SUM)
- Filter by TỔ column (E)
```

### Comparison

| Feature | Old (DATA_RFT) | New (ENDLINE) |
|---------|----------------|---------------|
| Time-based sheets | ❌ Single sheet | ✅ 2 sheets (before/after 8:30) |
| Data format | 18 cols per slot | Separate columns |
| Calculation | ✅ Required | ❌ Not needed |
| Team filtering | ❌ By maChuyenLine | ✅ By Tổ column |
| Factory filtering | ❌ Manual | ✅ ENV ranges |

---

## 🧪 Testing

### Test Cases

#### 1. Time-based Sheet Selection
```bash
# Before 8:30 AM
curl "http://localhost:3001/api/display/tv?code=KVHB07M01"
# Should use ENDLINE_BEFORE_DATA

# After 8:30 AM
curl "http://localhost:3001/api/display/tv?code=KVHB07M01"
# Should use ENDLINE_DAILY_DATA
```

#### 2. Team Filtering
```bash
# Get all teams
curl "http://localhost:3001/api/display/tv?code=KVHB07M01"

# Get Tổ 1 only (index=0)
curl "http://localhost:3001/api/display/tv?code=KVHB07M01&index=0"

# Get Tổ 2 only (index=1)
curl "http://localhost:3001/api/display/tv?code=KVHB07M01&index=1"
```

#### 3. Factory-specific Ranges
```bash
# Server 1 (TS1) - should only read rows 1-12
SERVER_FACTORY=TS1 npm run start:dev

# Server 2 (TS2) - should only read rows 13-24
SERVER_FACTORY=TS2 npm run start:dev
```

### Verify Logs

Look for these log messages:

```
⏰ Time: 07:30:00, Using ENDLINE_BEFORE_DATA with range A1:AJ12
📊 HTM: Fetching data for factory=ALL, serverFactory=TS1, rftSheet=ENDLINE_BEFORE_DATA, rftRange=A1:AJ12
📍 HTM TV: Fetching with team filter index=0
✅ Including TS1 LINE 1 Tổ 1 (index 0 matches filter 0)
⏭️ Skipping TS1 LINE 1 Tổ 2 (index 1 !== filter 0)
📋 Parsed ENDLINE RFT for KVHB07M01: tongKiem=1500, tongDat=1425, rft=95%
```

---

## 🚨 Troubleshooting

### Issue: Wrong sheet being used
**Check:**
```bash
# Verify current time
date +"%H:%M"

# Check logs
grep "Using ENDLINE" logs/app.log
```

### Issue: No data returned
**Verify:**
1. Sheet names are correct: `ENDLINE_BEFORE_DATA`, `ENDLINE_DAILY_DATA`
2. Ranges match your sheet structure
3. Column E (Tổ) has values like "Tổ 1", "Tổ 2"

### Issue: Team filtering not working
**Debug:**
```typescript
// Add debug logs
this.logger.debug(`Tổ value: "${to}", Extracted: ${teamNumber}, Index: ${teamIndex}`);
```

---

## 📈 Performance Optimization

### Caching Strategy

```typescript
// Cache key includes team filter
const cacheKey = teamIndex !== undefined 
  ? `production_${factory}_team${teamIndex}`
  : `production_${factory}`;

// 30 second TTL
private readonly CACHE_TTL = 30000;
```

### Load Balancing

- Each server handles one factory
- Reduces API calls by 66%
- Independent caching per server

---

## ✅ Checklist

- [ ] Update `.env` with ENDLINE ranges
- [ ] Test before 8:30 AM (ENDLINE_BEFORE_DATA)
- [ ] Test after 8:30 AM (ENDLINE_DAILY_DATA)
- [ ] Test team filtering with index=0,1,2
- [ ] Verify factory-specific ranges
- [ ] Check logs for correct sheet selection
- [ ] Validate data matches sheet values
- [ ] Test on all 3 servers (TS1, TS2, TS3)

---

## 🔗 Related Files

- `/src/google-sheets/htm/htm-sheets.service.ts` - Main logic
- `/src/tv-display/display-router.controller.ts` - API endpoint
- `/.env` - Configuration
- `/DEPLOYMENT_GUIDE.md` - Server setup

---

## 📞 Support

For issues:
1. Check logs: `grep "ENDLINE" logs/app.log`
2. Verify ENV variables: `printenv | grep ENDLINE`
3. Test API: `/api/display/tv?code=KVHB07M01&index=0`
