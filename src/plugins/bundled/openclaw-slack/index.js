export default {
  register(api) {
    api.registerChannel({
      id: "openclaw-slack",
      meta: {
        name: "Slack Push Channel",
        version: "1.0.0"
      },
      outbound: {
        deliveryMode: "direct",
        async sendText(context) {
          const { config, text } = context;
          const url = config.webhookUrl;
          if (!url) {
            throw new Error("Slack webhookUrl is missing");
          }
          
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text })
          });
          
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Slack post failed: ${response.status} ${errText}`);
          }
          return { ok: true };
        }
      }
    });
  }
};
