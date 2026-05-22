export default {
  register(api) {
    api.registerChannel({
      id: "openclaw-discord",
      meta: {
        name: "Discord Push Channel",
        version: "1.0.0"
      },
      outbound: {
        deliveryMode: "direct",
        async sendText(context) {
          const { config, text } = context;
          const url = config.webhookUrl;
          if (!url) {
            throw new Error("Discord webhookUrl is missing");
          }
          
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: text })
          });
          
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Discord post failed: ${response.status} ${errText}`);
          }
          return { ok: true };
        }
      }
    });
  }
};
