FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN ./node_modules/.bin/tsc -p tsconfig.json && node -e "require('node:fs').cpSync('src/ui','dist/ui',{recursive:true,force:true})"
EXPOSE 3000
CMD ["node", "dist/cli/index.js", "serve"]
