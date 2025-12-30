// Test script to list all sheet names in the Google Spreadsheet
const fs = require('fs');
const path = require('path');

// Load .env manually
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    const key = match[1].trim();
    let value = match[2].trim();
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
});

const { google } = require('googleapis');

async function listSheetNames() {
  try {
    const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    
    if (!serviceAccountKey || !spreadsheetId) {
      console.error('❌ Missing GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SHEET_ID in .env');
      return;
    }

    const credentials = JSON.parse(serviceAccountKey);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    console.log(`\n📊 Fetching sheet metadata for: ${spreadsheetId}\n`);
    
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    console.log(`✅ Spreadsheet Title: ${response.data.properties.title}\n`);
    console.log('📋 All Sheet Names:\n');
    
    response.data.sheets.forEach((sheet, index) => {
      const title = sheet.properties.title;
      const sheetId = sheet.properties.sheetId;
      const rowCount = sheet.properties.gridProperties.rowCount;
      const colCount = sheet.properties.gridProperties.columnCount;
      
      console.log(`${index + 1}. "${title}"`);
      console.log(`   - Sheet ID: ${sheetId}`);
      console.log(`   - Grid Size: ${rowCount} rows x ${colCount} columns\n`);
    });
    
    // Check for specific sheets
    const sheetNames = response.data.sheets.map(s => s.properties.title);
    
    console.log('🔍 Checking for ENDLINE sheets:\n');
    
    const beforeSheet = sheetNames.find(name => name.includes('BEFORE'));
    const dailySheet = sheetNames.find(name => name.includes('DAILY'));
    
    console.log(`ENDLINE_BEFORE_DATA: ${sheetNames.includes('ENDLINE_BEFORE_DATA') ? '✅ EXISTS' : '❌ NOT FOUND'}`);
    console.log(`ENDLINE_DAILY_DATA: ${sheetNames.includes('ENDLINE_DAILY_DATA') ? '✅ EXISTS' : '❌ NOT FOUND'}`);
    
    if (beforeSheet) console.log(`\n💡 Found similar: "${beforeSheet}"`);
    if (dailySheet) console.log(`💡 Found similar: "${dailySheet}"`);
    
    // Test reading from ENDLINE_DAILY_DATA (the one that works)
    if (sheetNames.includes('ENDLINE_DAILY_DATA')) {
      console.log('\n\n🧪 Testing read from ENDLINE_DAILY_DATA (TS3 range: A22:AJ33):\n');
      try {
        const testRead = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: 'ENDLINE_DAILY_DATA!A22:AJ33',
        });
        console.log(`✅ Successfully read ${testRead.data.values?.length || 0} rows`);
      } catch (err) {
        console.error(`❌ Failed to read: ${err.message}`);
      }
    }
    
    // Test reading from ENDLINE_BEFORE_DATA (the one that fails)
    console.log('\n🧪 Testing read from ENDLINE_BEFORE_DATA (TS3 range: A22:AJ33):\n');
    try {
      const testRead = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'ENDLINE_BEFORE_DATA!A22:AJ33',
      });
      console.log(`✅ Successfully read ${testRead.data.values?.length || 0} rows`);
    } catch (err) {
      console.error(`❌ Failed to read: ${err.message}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

listSheetNames();
