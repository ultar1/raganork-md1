FROM node:22-alpine

# Install dependencies
RUN apk add --no-cache \
    git \
    ffmpeg \
    libwebp-tools \
    python3 \
    make \
    g++ \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Clone the bot repository
ADD https://api.github.com/repos/souravkl11/raganork-md/git/refs/heads/main version.json
RUN git clone -b main https://github.com/souravkl11/raganork-md /rgnk

WORKDIR /rgnk
RUN mkdir -p temp

# Set timezone
ENV TZ=Asia/Kolkata

# Install global dependencies
RUN npm install -g --force yarn pm2

# Install bot dependencies
RUN yarn install

# Install Puppeteer with Chromium support
RUN yarn add puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

CMD ["npm", "start"]
