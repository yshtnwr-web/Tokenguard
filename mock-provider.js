import express from 'express';
const app = express();
app.use(express.json());

app.post('/v1/chat/completions', (req, res) => {
  res.json({
    id: `mock-${Date.now()}`,
    object: 'chat.completion',
    model: req.body.model,
    choices: [{ message: { role: 'assistant', content: '[MOCK] Simulated response.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 150, completion_tokens: 60 }
  });
});

app.listen(4000, () => console.log('Mock provider on port 4000'));