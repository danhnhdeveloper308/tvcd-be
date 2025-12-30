#!/bin/bash

echo "🚀 Setting up Live Chart Backend..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version)
echo "✅ Node.js version: $NODE_VERSION"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Check if NestJS CLI is installed globally
if ! command -v nest &> /dev/null; then
    echo "🔧 Installing NestJS CLI globally..."
    npm install -g @nestjs/cli
fi

# Create dist directory if not exists
mkdir -p dist

# Check TypeScript compilation
echo "🔍 Checking TypeScript compilation..."
npx tsc --noEmit

if [ $? -eq 0 ]; then
    echo "✅ TypeScript compilation successful"
else
    echo "❌ TypeScript compilation failed. Please check the errors above."
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating sample .env file..."
    cat > .env << EOL
# Google Sheets Configuration
GOOGLE_SERVICE_ACCOUNT_KEY="{}"
GOOGLE_SHEET_ID=""
GOOGLE_DRIVE_FOLDER_ID=""

# Security
CRON_SECRET="your-secret-here"
ADMIN_PASSWORD="123456"

# Optional
GOOGLE_SHEET_API_KEY=""
GOOGLE_SHEET_ID_DATA=""

# Server
PORT=3001
NODE_ENV=development

# Frontend URL for CORS
FRONTEND_URL=http://localhost:3000
EOL
    echo "📝 Sample .env file created. Please update it with your actual values."
fi

echo "🎉 Setup completed successfully!"
echo ""
echo "Next steps:"
echo "1. Update the .env file with your Google Sheets credentials"
echo "2. Run 'npm run start:dev' to start the development server"
echo "3. Visit http://localhost:3001/api/production/health to test"