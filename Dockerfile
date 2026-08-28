FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Не делаем npm run build, просто смотрим файлы
CMD ["sh", "-c", "ls -R /app/src"]
