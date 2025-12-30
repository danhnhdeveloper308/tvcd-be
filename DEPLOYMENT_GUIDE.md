# 🚀 Multi-Server Deployment Guide

## 📋 Overview

Hệ thống được thiết kế để deploy trên **3-4 servers** nhằm chia tải cho ~45 TVs hoạt động 11 giờ/ngày.

### Kiến trúc Load Balancing

```
┌─────────────────────────────────────────────────────┐
│         Google Sheets (Single Source)               │
│  Sheet: DATA BCSL HTM, DATA_RFT, DATA_CD            │
└──────────────┬──────────────────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│  Server 1   │  │  Server 2   │  │  Server 3   │
│   (TS1)     │  │   (TS2)     │  │   (TS3)     │
│ Rows 1-14   │  │ Rows 15-27  │  │ Rows 28-40  │
│  ~15 TVs    │  │  ~15 TVs    │  │  ~15 TVs    │
└─────────────┘  └─────────────┘  └─────────────┘
```

---

## 🎯 Deployment Strategy

### Option 1: ✅ **RECOMMENDED - Single Sheet with Range Splitting**

**Pros:**
- ✅ Single source of truth
- ✅ No data sync issues
- ✅ Easier maintenance
- ✅ Lower API quota usage
- ✅ Real-time consistency

**Cons:**
- ⚠️ All servers depend on one sheet (but with good caching)

### Option 2: Multiple Sheets (Not Recommended)

**Pros:**
- Complete isolation between factories

**Cons:**
- ❌ Data duplication
- ❌ Sync complexity
- ❌ Higher maintenance cost
- ❌ Inconsistent data risk
- ❌ 3x API quota usage

---

## 🛠️ Setup Instructions

### 1️⃣ **Server 1 - TS1 Factory (15 TVs)**

**Location:** Railway/Vercel/Your hosting

**Environment Variables:**
```bash
# Copy from .env.example
SERVER_FACTORY="TS1"
HTM_DATA_RANGE="A1:CO14"
HTM_RFT_RANGE="A3:GT14"
HTM_LINES_RANGE="A1:CO14"
CD_DATA_RANGE="A1:BF50"
HTM_CENTER_TV_RANGE="A1:AA15"

PORT=3001
GOOGLE_SHEET_ID="your-sheet-id"
# ... other configs
```

**TV Display URLs:**
- `https://server1.com/api/display/tv?code=KVHB07M01`
- `https://server1.com/api/display/center-tv?factory=TS1&line=1`

---

### 2️⃣ **Server 2 - TS2 Factory (15 TVs)**

**Environment Variables:**
```bash
SERVER_FACTORY="TS2"
HTM_DATA_RANGE="A15:CO27"
HTM_RFT_RANGE="A15:GT27"
HTM_LINES_RANGE="A15:CO27"
CD_DATA_RANGE="A1:BF50"
HTM_CENTER_TV_RANGE="A15:AA27"

PORT=3001
# Same GOOGLE_SHEET_ID
```

**TV Display URLs:**
- `https://server2.com/api/display/tv?code=KVHB07M02`

---

### 3️⃣ **Server 3 - TS3 Factory (15 TVs)**

**Environment Variables:**
```bash
SERVER_FACTORY="TS3"
HTM_DATA_RANGE="A28:CO40"
HTM_RFT_RANGE="A28:GT40"
HTM_LINES_RANGE="A28:CO40"
CD_DATA_RANGE="A1:BF50"
HTM_CENTER_TV_RANGE="A28:AA40"

PORT=3001
# Same GOOGLE_SHEET_ID
```

---

### 4️⃣ **Main Server - Railway (Backup/Fallback)**

**Environment Variables:**
```bash
SERVER_FACTORY="ALL"
HTM_DATA_RANGE="A1:CO50"
HTM_RFT_RANGE="A3:GT37"
HTM_LINES_RANGE="A1:CO40"
CD_DATA_RANGE="A1:BF200"
HTM_CENTER_TV_RANGE="A1:AA38"

PORT=3001
```

This server can handle all factories as backup.

---

## 📊 Google Sheet Structure

### DATA BCSL HTM Sheet

| Rows   | Factory | Lines        | Server  |
|--------|---------|--------------|---------|
| 1      | Header  | -            | All     |
| 2-14   | TS1     | M01-M12      | Server 1|
| 15-27  | TS2     | M13-M24      | Server 2|
| 28-40  | TS3     | M25-M36      | Server 3|

### DATA_RFT Sheet (Same structure)

### DATA_CD Sheet

| Rows   | CD Lines      | Factory | Server  |
|--------|---------------|---------|---------|
| 1-15   | CD16-19       | TS1     | Server 1|
| 16-30  | CD20-23       | TS2     | Server 2|
| 31-45  | CD24-27       | TS3     | Server 3|

---

## 🔄 How It Works

### 1. **Data Fetching**
Each server reads **only its designated row range**:

```typescript
// Server 1 (TS1)
getSheetData('DATA BCSL HTM', 'A1:CO14')  // Only TS1 rows

// Server 2 (TS2)  
getSheetData('DATA BCSL HTM', 'A15:CO27') // Only TS2 rows

// Server 3 (TS3)
getSheetData('DATA BCSL HTM', 'A28:CO40') // Only TS3 rows
```

### 2. **Caching Strategy**
- **In-memory cache**: 30 seconds (HTM), 15 seconds (CD)
- **Reduces API calls** by ~95%
- Each server maintains independent cache

### 3. **Cron Jobs**
```typescript
@Cron('*/2 8-20 * * 1-6') // Every 2 minutes during work hours
```
- Runs independently on each server
- Only processes designated factory data
- Active production block detection

### 4. **WebSocket Updates**
- Each server emits updates for its factory
- TVs subscribe to their designated server
- Real-time push notifications

---

## 📈 Performance Benefits

### API Call Reduction

**Before (Single Server):**
```
- 50 lines × 11 hours × 30 checks/hour = 16,500 API calls/day
```

**After (3 Servers with ranges):**
```
Server 1: 14 lines × 11 hours × 30 = 4,620 calls/day
Server 2: 13 lines × 11 hours × 30 = 4,290 calls/day  
Server 3: 13 lines × 11 hours × 30 = 4,290 calls/day
Total: 13,200 calls/day (20% reduction)
```

### With Caching (30s TTL):
```
Each server: ~500 API calls/day
Total: ~1,500 API calls/day (91% reduction!)
```

---

## 🚨 Monitoring & Logs

### Check Server Configuration
Look for log messages:
```
📊 HTM: Fetching data for factory=TS1, serverFactory=TS1, dataRange=A1:CO14
```

### Verify Range Loading
```bash
curl https://your-server.com/api/display/lines?type=HTM
```

Should return only lines for that server's factory.

### WebSocket Connections
```
✅ Client connected: socket-id-123
📡 Subscription confirmed for: production:TS1:all:all
```

---

## 🔧 Deployment Commands

### Build & Deploy
```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Start production
pnpm start:prod
```

### Docker Deployment
```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod

COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3001

CMD ["node", "dist/main"]
```

### Railway Deployment
```bash
# Set environment variables in Railway dashboard
SERVER_FACTORY=TS1
HTM_DATA_RANGE=A1:CO14
HTM_RFT_RANGE=A3:GT14
# ... other ENV vars

# Deploy
railway up
```

---

## 🎯 TV Display Configuration

### Map TVs to Servers

**TS1 Factory TVs (15 TVs) → Server 1:**
```
TV1:  https://server1.com/api/display/tv?code=KVHB07M01
TV2:  https://server1.com/api/display/tv?code=KVHB07M02
...
TV15: https://server1.com/api/display/tv?code=KVHB07M12
```

**TS2 Factory TVs (15 TVs) → Server 2:**
```
TV16: https://server2.com/api/display/tv?code=KVHB07M13
TV17: https://server2.com/api/display/tv?code=KVHB07M14
...
```

**TS3 Factory TVs (15 TVs) → Server 3:**
```
TV31: https://server3.com/api/display/tv?code=KVHB07M25
...
```

---

## ⚡ Performance Tuning

### Adjust Cache TTL
For faster updates (more API calls):
```typescript
private readonly CACHE_TTL = 15000; // 15 seconds
```

For fewer API calls (slower updates):
```typescript
private readonly CACHE_TTL = 60000; // 60 seconds
```

### Adjust Cron Frequency
```typescript
@Cron('*/5 8-20 * * 1-6') // Every 5 minutes (fewer checks)
@Cron('*/1 8-20 * * 1-6') // Every 1 minute (more frequent)
```

---

## 🐛 Troubleshooting

### Issue: Server not reading correct range
**Check logs:**
```
📊 HTM: Fetching data for factory=TS1, serverFactory=TS1, dataRange=A1:CO14
```

**Verify ENV:**
```bash
echo $SERVER_FACTORY
echo $HTM_DATA_RANGE
```

### Issue: Empty data returned
**Check sheet permissions:**
- Service account has read access
- Sheet ID is correct
- Range format is valid (e.g., `A1:CO14`)

### Issue: Quota exceeded
**Solutions:**
- Increase CACHE_TTL
- Reduce cron frequency
- Verify range splitting is working

---

## 📝 Maintenance

### Update Data Structure
If sheet structure changes, update ranges in `.env`:
```bash
HTM_DATA_RANGE="A1:CZ50"  # Extended columns
```

### Add New Factory (TS4)
1. Add rows to sheet (41-53)
2. Deploy Server 4:
   ```bash
   SERVER_FACTORY="TS4"
   HTM_DATA_RANGE="A41:CO53"
   ```

### Scale Horizontally
Add more servers per factory if needed:
```bash
# TS1 - Server A (Lines 1-7)
HTM_DATA_RANGE="A1:CO7"

# TS1 - Server B (Lines 8-14)  
HTM_DATA_RANGE="A8:CO14"
```

---

## ✅ Checklist Before Deployment

- [ ] Copy `.env.example` to `.env`
- [ ] Set `SERVER_FACTORY` correctly
- [ ] Configure row ranges for factory
- [ ] Verify Google Sheet ID
- [ ] Test API endpoint: `/api/display/lines`
- [ ] Check logs for correct range loading
- [ ] Configure TV display URLs
- [ ] Monitor API quota usage
- [ ] Set up error alerting

---

## 📞 Support

Check logs at:
```
📊 HTM: Fetching data...
🔄 Data updated for KVHB07M01
✅ Client connected: socket-123
```

For issues, verify:
1. Environment variables are set
2. Google Sheets access is working
3. Ranges match your sheet structure
4. Caching is functioning
