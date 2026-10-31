FROM node:22-alpine
ARG SHOPIFY_API_KEY
ENV SHOPIFY_API_KEY=$SHOPIFY_API_KEY
ENV NODE_ENV=production
EXPOSE 8081
ENV PORT=8081
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --include=dev
COPY web .
RUN npm --prefix frontend ci --include=dev && npm --prefix frontend run build
CMD ["npm", "run", "serve"]
