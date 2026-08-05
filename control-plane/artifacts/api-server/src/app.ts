import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import healthRouter from "./routes/health";
import chatRouter from "./routes/chat";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Chat payloads carry full message histories, well past express.json's 100kb default.
app.use(express.json({ limit: "8mb" }));

// Health check (Railway).
app.use(healthRouter); // GET /healthz
// The OpenAI-compatible gateway. The mint response hands the CLI a
// gatewayBaseUrl ending in /v1, so its OpenAI SDK calls POST /v1/chat/completions.
app.use("/v1", chatRouter);

export default app;
