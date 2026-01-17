import { load } from "cheerio";
import { baseUrl } from "./config.js";

export type SuchprofilForm = {
  action: string;
  method: string;
  fields: URLSearchParams;
};

export const parseSuchprofilForm = (html: string): SuchprofilForm => {
  const $ = load(html);
  const form = $("form#detailsuche-form");
  if (form.length === 0) {
    throw new Error("Suchprofil form not found.");
  }

  const action = new URL(form.attr("action") ?? "", baseUrl).toString();
  const method = (form.attr("method") ?? "get").toLowerCase();
  const fields = new URLSearchParams();

  form.find("input[name], select[name], textarea[name]").each((_, el) => {
    const node = $(el);
    const name = node.attr("name");
    if (!name) return;
    if (node.is(":disabled")) return;

    const tag = el.tagName.toLowerCase();
    const type = (node.attr("type") ?? "text").toLowerCase();

    if (type === "radio" || type === "checkbox") {
      if (!node.is(":checked")) return;
    }

    if (tag === "select") {
      node.find("option:selected").each((__, option) => {
        const value = $(option).attr("value") ?? $(option).text().trim();
        fields.append(name, value);
      });
      return;
    }

    const value = node.attr("value") ?? node.val()?.toString() ?? "";
    fields.append(name, value);
  });

  if (!fields.has("action")) {
    const submit = form.find("button[name='action'][value]").first().attr("value");
    if (submit) {
      fields.append("action", submit);
    }
  }

  return { action, method, fields };
};
