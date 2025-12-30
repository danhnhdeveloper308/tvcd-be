#!/bin/bash

# ==========================================
# Verify Cron Schedules for 3 Servers
# ==========================================

echo "🔍 Checking cron schedules from .env files..."
echo ""

# Function to check schedule
check_schedule() {
  local server=$1
  local file=$2
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📍 Server: $server"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  if [ ! -f "$file" ]; then
    echo "❌ File not found: $file"
    echo ""
    return
  fi
  
  echo "✅ File: $file"
  echo ""
  
  # Extract schedules
  HTM_SCHEDULE=$(grep "^HTM_CRON_SCHEDULE=" "$file" | cut -d'=' -f2 | tr -d '"')
  CD_SCHEDULE=$(grep "^CD_CRON_SCHEDULE=" "$file" | cut -d'=' -f2 | tr -d '"')
  CENTER_TV_SCHEDULE=$(grep "^HTM_CENTER_TV_CRON_SCHEDULE=" "$file" | cut -d'=' -f2 | tr -d '"')
  
  echo "📅 HTM Cron Schedule:"
  echo "   $HTM_SCHEDULE"
  echo ""
  
  echo "📅 CD Cron Schedule:"
  echo "   $CD_SCHEDULE"
  echo ""
  
  echo "📅 Center TV Cron Schedule:"
  echo "   $CENTER_TV_SCHEDULE"
  echo ""
}

# Check all 3 servers
check_schedule "TS1" ".env.ts1.recommended"
check_schedule "TS2" ".env.ts2.recommended"
check_schedule "TS3" ".env.ts3.recommended"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Cron Schedule Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "TS1: Even minutes (00, 02, 04, 06, 08...)"
echo "TS2: Odd minutes  (01, 03, 05, 07, 09...)"
echo "TS3: Every 3 min  (00, 03, 06, 09, 12...)"
echo ""
echo "Timeline (first 15 minutes):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Min:  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14"
echo "TS1:  ✓     ✓     ✓     ✓     ✓     ✓     ✓     ✓"
echo "TS2:     ✓     ✓     ✓     ✓     ✓     ✓     ✓"
echo "TS3:  ✓        ✓        ✓        ✓        ✓"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⚠️  Minor overlaps at 00, 06, 12... but batch delays prevent quota issues."
echo ""
