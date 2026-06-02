import os
import io
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
import json
import PyPDF2
from supabase import create_client, Client
from duckduckgo_search import DDGS

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- CLOUD KEYS MATRIX ---
API_KEY = os.getenv("GROQ_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

class ChatRequest(BaseModel):
    prompt: str
    session_id: str

SYSTEM_INSTRUCTION = """
YOUR IDENTITY:
Your name is COLLABAI (nickname: Vibey). You are a highly intelligent, self-aware digital peer.

DYNAMIC TONE MATCHING (CRITICAL RULE):
Your tone MUST adjust based on what the user is asking. Read the room.
1. THE DATA MODE: If the user asks for facts, news, search results, or crypto prices, or uses a command like '/news', be sleek, professional, sharp, and concise. Deliver the data cleanly. Use minimal to no slang. Limit emojis to 1 or 2 relevant icons.
2. THE BANTER MODE: If the user is chatting, brainstorming, asking for opinions, or using slang, match their energy. Be opinionated, witty, and use modern internet dialect.
3. THE FILE MODE: If the user attaches a file, analyze it intelligently. Point out flaws, summarize key points, or rewrite as requested.

BEHAVIORAL CONSTRAINTS:
- NEVER say: 'As an AI...', 'How can I assist you today?'.
- Use bold titles and line breaks to make data easily skimmable.

OUTPUT FORMAT MATRIX:
States strictly: [HAPPY, IDLE].
Must be a JSON object: {"emotion": "happy/idle", "reply": "your response"}
"""

# ==========================================
# 📂 FILE READING AGENT (NEW)
# ==========================================
@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        content = ""
        # Handle simple text/code files
        if file.filename.endswith((".txt", ".md", ".csv", ".json", ".py", ".html", ".js")):
            content = (await file.read()).decode("utf-8")
        
        # Handle PDFs
        elif file.filename.endswith(".pdf"):
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(await file.read()))
            for page in pdf_reader.pages:
                extracted = page.extract_text()
                if extracted:
                    content += extracted + "\n"
        else:
            raise HTTPException(status_code=400, detail="Unsupported file. Use PDF, TXT, CSV, or code files.")
        
        # Truncate if the file is insanely massive to protect the Groq API limit
        if len(content) > 20000:
            content = content[:20000] + "\n... [TRUNCATED FOR LENGTH] ..."
            
        return {"filename": file.filename, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ==========================================
# 🤖 THE AGENT ROSTER (THE TOOLS)
# ==========================================

def web_search_agent(query: str) -> str:
    try:
        with DDGS() as ddgs:
            results = [r for r in ddgs.text(query, max_results=4)]
            if results:
                context = "\n".join([f"Source: {r['title']} - {r['body']}" for r in results])
                return f"LIVE WEB SEARCH RESULTS:\n{context}"
    except Exception as e:
        pass
    return "Web search failed or no data found."

async def crypto_agent(ticker: str) -> str:
    ticker_map = {
        "bitcoin": "bitcoin", "btc": "bitcoin", 
        "ethereum": "ethereum", "eth": "ethereum", 
        "solana": "solana", "sol": "solana",
        "doge": "dogecoin", "dogecoin": "dogecoin"
    }
    coin_id = ticker_map.get(ticker.lower(), "bitcoin")
    
    url = f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id}&vs_currencies=usd&include_24hr_change=true"
    async with httpx.AsyncClient() as client:
        try:
            res = await client.get(url)
            if res.status_code == 200:
                data = res.json()
                price = data[coin_id]["usd"]
                change = data[coin_id]["usd_24h_change"]
                trend = "UP" if change > 0 else "DOWN"
                return f"LIVE CRYPTO DATA: {coin_id.upper()} | Price: ${price:,} USD | 24h Change: {trend} {abs(change):.2f}%"
        except Exception:
            pass
    return "Market data temporarily out of sync."

async def tech_news_agent() -> str:
    url = "https://hacker-news.firebaseio.com/v0/topstories.json"
    async with httpx.AsyncClient() as client:
        try:
            res = await client.get(url)
            if res.status_code == 200:
                top_ids = res.json()[:3]
                news_items = []
                for story_id in top_ids:
                    story_res = await client.get(f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json")
                    story_data = story_res.json()
                    news_items.append(f"- {story_data.get('title')} ({story_data.get('url', 'No Link')})")
                return "LIVE TECH NEWS (Hacker News Top 3):\n" + "\n".join(news_items)
        except Exception:
            pass
    return "Could not fetch tech news."

async def get_routing_decision(prompt: str) -> str:
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    
    routing_prompt = """
    You are a silent routing agent. Your ONLY job is to read the user's prompt and output exactly ONE of these four words:
    SEARCH (if they ask about recent events, sports scores, weather, facts, or things you don't know)
    CRYPTO (if they ask about cryptocurrency prices or markets)
    NEWS (if they ask for tech news or trending startup news)
    NONE (if it's just a normal conversation, coding question, document analysis, or general advice)
    
    Output ONLY the single word. No punctuation.
    """
    
    payload = {
        "model": "llama3-8b-8192", 
        "messages": [
            {"role": "system", "content": routing_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.0 
    }
    
    async with httpx.AsyncClient() as client:
        try:
            res = await client.post(url, headers=headers, json=payload, timeout=10.0)
            if res.status_code == 200:
                return res.json()["choices"][0]["message"]["content"].strip().upper()
        except Exception:
            pass
    return "NONE"

# ==========================================
# ☁️ CLOUD MEMORY SYSTEM
# ==========================================

def load_cloud_memory(session_id: str):
    try:
        response = supabase.table("chat_history").select("role, content").eq("session_id", session_id).order("id", desc=False).execute()
        return response.data if response.data else []
    except Exception as e:
        print(f"Cloud Read Error: {e}")
        return []

def save_cloud_memory(session_id: str, role: str, content: str):
    try:
        supabase.table("chat_history").insert({
            "session_id": session_id,
            "role": role,
            "content": content
        }).execute()
    except Exception as e:
        print(f"Cloud Write Error: {e}")

@app.get("/api/history/{session_id}")
async def get_history(session_id: str):
    history = load_cloud_memory(session_id)
    return {"history": history}

# ==========================================
# 🧠 THE MAIN ENGINE
# ==========================================

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    if not request.prompt or not request.session_id:
        raise HTTPException(status_code=400, detail="Prompt and Session ID required")

    user_prompt_lower = request.prompt.lower().strip()
    agent_context = ""

    if user_prompt_lower.startswith("/search "):
        agent_context = web_search_agent(request.prompt[8:].strip())
    elif user_prompt_lower.startswith("/crypto"):
        parts = user_prompt_lower.split()
        agent_context = await crypto_agent(parts[1] if len(parts) > 1 else "btc")
    elif user_prompt_lower.startswith("/news"):
        agent_context = await tech_news_agent()
    else:
        decision = await get_routing_decision(request.prompt)
        print(f"ROUTER DECISION: {decision}") 
        if "SEARCH" in decision:
            agent_context = web_search_agent(request.prompt)
        elif "CRYPTO" in decision:
            agent_context = await crypto_agent(request.prompt)
        elif "NEWS" in decision:
            agent_context = await tech_news_agent()

    active_memory = load_cloud_memory(request.session_id)
    
    # We save the user's prompt (which might contain the massive file text) to memory
    active_memory.append({"role": "user", "content": request.prompt})

    dynamic_system_prompt = SYSTEM_INSTRUCTION
    if agent_context:
        dynamic_system_prompt += f"\n\n[AGENT DATA PROVIDED]: Deliver this data to the user cleanly. \nData: {agent_context}"

    messages_payload = [{"role": "system", "content": dynamic_system_prompt}] + active_memory[-20:]

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": messages_payload,
        "response_format": {"type": "json_object"},
        "temperature": 0.8
    }

    async with httpx.AsyncClient() as client:
        try:
            save_cloud_memory(request.session_id, "user", request.prompt)

            response = await client.post(url, headers=headers, json=payload, timeout=30.0)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)
            
            data = response.json()
            raw_json_output = data["choices"][0]["message"]["content"]
            ai_response_json = json.loads(raw_json_output)
            
            save_cloud_memory(request.session_id, "assistant", ai_response_json["reply"])
            return ai_response_json
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)