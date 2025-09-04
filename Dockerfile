# استخدم صورة Node الرسمية
FROM node:18-slim

# تثبيت متطلبات Puppeteer (كروم)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libdrm-dev \
    libxkbcommon-x11-0 \
    libgbm-dev \
    libgtk-3-0 \
    libnss3 \
    libxss1 \
    libasound2 \
    libxshmfence1 \
    xdg-utils \
    wget \
 && rm -rf /var/lib/apt/lists/*

# تعيين متغير Puppeteer لاستخدام Chromium من النظام
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# مجلد العمل
WORKDIR /app

# نسخ الملفات
COPY package*.json ./
RUN npm install

COPY . .

# المنفذ (Back4App يمرر PORT)
EXPOSE 3000

# أمر التشغيل
CMD ["npm", "start"]
