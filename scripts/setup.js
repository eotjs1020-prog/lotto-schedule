const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");
const envExamplePath = path.join(rootDir, ".env.example");

if (!fs.existsSync(envPath)) {
  if (!fs.existsSync(envExamplePath)) {
    console.error(".env.example 파일이 없어서 .env를 생성할 수 없습니다.");
    process.exit(1);
  }

  fs.copyFileSync(envExamplePath, envPath);
  console.log(".env 파일이 없어서 .env.example 기반으로 새로 생성했습니다.");
  console.log("필수 값(DISCORD_TOKEN, CLIENT_ID 등)을 .env에 입력해 주세요.");
} else {
  console.log(".env 파일이 이미 있어서 그대로 사용합니다.");
}
