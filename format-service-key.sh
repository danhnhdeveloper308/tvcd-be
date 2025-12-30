#!/bin/bash

echo "🔧 Google Service Account Key Formatter"
echo "This script helps format your Google Service Account Key for .env file"
echo ""

# Check if jq is available
if ! command -v jq &> /dev/null; then
    echo "⚠️  jq is not installed. Installing jq for JSON formatting..."
    
    # Try to install jq based on OS
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        sudo apt-get update && sudo apt-get install -y jq
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install jq
    else
        echo "❌ Please install jq manually: https://stedolan.github.io/jq/download/"
        exit 1
    fi
fi

echo "📝 Please provide your Google Service Account Key JSON file path:"
read -r key_file_path

if [ ! -f "$key_file_path" ]; then
    echo "❌ File not found: $key_file_path"
    exit 1
fi

echo ""
echo "🔄 Processing JSON file..."

# Format the JSON as a single line and escape it properly for .env
formatted_key=$(jq -c . "$key_file_path" | sed 's/"/\\"/g')

echo ""
echo "✅ Formatted key for .env file:"
echo "GOOGLE_SERVICE_ACCOUNT_KEY=\"$formatted_key\""
echo ""

# Optionally write to .env file
echo "💾 Do you want to update your .env file automatically? (y/n)"
read -r update_env

if [[ $update_env =~ ^[Yy]$ ]]; then
    # Backup existing .env
    if [ -f ".env" ]; then
        cp .env .env.backup
        echo "📋 Backed up existing .env to .env.backup"
    fi
    
    # Update or add the GOOGLE_SERVICE_ACCOUNT_KEY
    if grep -q "GOOGLE_SERVICE_ACCOUNT_KEY=" .env 2>/dev/null; then
        # Update existing key
        sed -i.bak "s|GOOGLE_SERVICE_ACCOUNT_KEY=.*|GOOGLE_SERVICE_ACCOUNT_KEY=\"$formatted_key\"|" .env
        echo "✅ Updated GOOGLE_SERVICE_ACCOUNT_KEY in .env file"
    else
        # Add new key
        echo "GOOGLE_SERVICE_ACCOUNT_KEY=\"$formatted_key\"" >> .env
        echo "✅ Added GOOGLE_SERVICE_ACCOUNT_KEY to .env file"
    fi
    
    echo ""
    echo "🎉 Done! Your .env file has been updated."
    echo "🔍 You can now test the connection by running: npm run start:dev"
else
    echo "📋 Copy the line above and manually add it to your .env file"
fi

echo ""
echo "🚀 Next steps:"
echo "1. Make sure your .env file contains the formatted GOOGLE_SERVICE_ACCOUNT_KEY"
echo "2. Verify GOOGLE_SHEET_ID is set correctly"
echo "3. Run: npm run start:dev"
echo "4. Check: curl http://localhost:3001/api/production/health"