#!/bin/bash

echo "🤖 Gemini CLI Setup for Overview App"
echo "===================================="
echo ""
echo "Choose your authentication method:"
echo ""
echo "1) OAuth login (Google Account) - Recommended"
echo "   - Free tier: 60 requests/min, 1,000 requests/day"
echo "   - No API key needed"
echo ""
echo "2) Gemini API Key"
echo "   - Free tier: 100 requests/day"
echo "   - Get key from: https://aistudio.google.com/apikey"
echo ""
echo "3) Vertex AI (Enterprise)"
echo "   - For Google Cloud users"
echo ""

if [ -n "$1" ]; then
    api_key="$1"
    choice=2 # Force choice to 2 if API key is provided as argument
else
    read -p "Enter your choice (1-3): " choice
fi

case $choice in
    1)
        echo ""
        echo "OAuth setup:"
        echo "1. Run: gemini"
        echo "2. Choose OAuth when prompted"
        echo "3. Follow the browser authentication flow"
        echo ""
        echo "No environment variables needed for OAuth!"
        ;;
    2)
        echo ""
        echo "Get your API key from: https://aistudio.google.com/apikey"
        if [ -z "$api_key" ]; then # Only prompt if api_key is not already set from arguments
            read -p "Enter your GEMINI_API_KEY: " api_key
        fi
        
        # Add to shell profile
        echo "" >> ~/.zshrc
        echo "# Gemini CLI API Key for Overview App" >> ~/.zshrc
        echo "export GEMINI_API_KEY=\"$api_key\"" >> ~/.zshrc
        
        export GEMINI_API_KEY="$api_key"
        
        echo ""
        echo "✅ API key saved to ~/.zshrc"
        echo "✅ Key is now active in current session"
        ;;
    3)
        echo ""
        read -p "Enter your GOOGLE_API_KEY: " google_key
        read -p "Enter your Google Cloud Project ID: " project_id
        
        # Add to shell profile
        echo "" >> ~/.zshrc
        echo "# Vertex AI configuration for Overview App" >> ~/.zshrc
        echo "export GOOGLE_API_KEY=\"$google_key\"" >> ~/.zshrc
        echo "export GOOGLE_GENAI_USE_VERTEXAI=true" >> ~/.zshrc
        echo "export GOOGLE_CLOUD_PROJECT=\"$project_id\"" >> ~/.zshrc
        
        export GOOGLE_API_KEY="$google_key"
        export GOOGLE_GENAI_USE_VERTEXAI=true
        export GOOGLE_CLOUD_PROJECT="$project_id"
        
        echo ""
        echo "✅ Vertex AI configuration saved to ~/.zshrc"
        echo "✅ Configuration is now active in current session"
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "Testing Gemini CLI..."
echo "====================="

# Test gemini command
if command -v gemini &> /dev/null; then
    echo "✅ Gemini CLI is installed at: $(which gemini)"
    
    # Try to run a simple test
    echo ""
    echo "Running test command..."
    echo "Say 'hello world'" | timeout 5 gemini -p "Say 'hello world'" 2>&1 | head -5
    
    if [ $? -eq 0 ]; then
        echo ""
        echo "✅ Gemini CLI is working!"
    else
        echo ""
        echo "⚠️  Gemini might need additional setup. Run 'gemini' directly to configure."
    fi
else
    echo "❌ Gemini CLI not found. Please install with: npm install -g @google/gemini-cli"
fi

echo ""
echo "Overview App will now use Gemini as a fallback when Claude is unavailable!"