FROM node:22-alpine

ARG SHOPIFY_API_KEY

ENV NODE_ENV=production
ENV PORT=8081

WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci --include=dev

COPY web .

RUN npm --prefix frontend ci --include=dev

RUN test -n "$SHOPIFY_API_KEY" \
    && SHOPIFY_API_KEY="$SHOPIFY_API_KEY" \
       npm --prefix frontend run build

EXPOSE 8081

CMD ["npm", "run", "serve"]
