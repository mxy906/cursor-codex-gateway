import { Router } from "express";
import { HttpError } from "../errors";
import type { ModelCatalog } from "../cursor/modelCatalog";

export function createModelsRouter(modelCatalog: ModelCatalog): Router {
  const router = Router();

  router.get("/v1/models", (req, res, next) => {
    void (async () => {
      try {
        if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
        const list = await modelCatalog.toOpenAIModelList(req.cursorApiKey);
        if (req.header("anthropic-version")) {
          const data = list.data.map((model) => ({
            type: "model" as const,
            id: model.id,
            display_name: model.id,
            created_at: new Date(model.created * 1000).toISOString(),
          }));
          res.json({
            data,
            has_more: false,
            first_id: data[0]?.id ?? null,
            last_id: data.at(-1)?.id ?? null,
          });
          return;
        }
        res.json(list);
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get("/v1/models/:id", (req, res, next) => {
    void (async () => {
      try {
        if (!req.cursorApiKey) throw HttpError.unauthorized("No Cursor API key resolved for this request.");
        const list = await modelCatalog.toOpenAIModelList(req.cursorApiKey);
        const found = list.data.find((model) => model.id === req.params.id);
        if (!found) throw HttpError.notFound(`Model "${req.params.id}" was not found in your Cursor account's catalog.`);
        res.json(found);
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
