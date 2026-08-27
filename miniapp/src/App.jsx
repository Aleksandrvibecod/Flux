import React, { useEffect, useState, useRef } from 'react'

const API = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

export default function App(){
  const [tab, setTab] = useState('home')
  const [data, setData] = useState({ transactions:[], calories:[], notes:[] })
  const getTgId = ()=> {
    const w = window.Telegram?.WebApp?.initDataUnsafe?.user?.id
    if (w) return w
    const p = new URLSearchParams(window.location.search)
    return Number(p.get('telegram_id') || p.get('tgId') || 0) || 12345
  }
  const tgId = getTgId()

  useEffect(()=>{
    fetch(`${API}/history?telegram_id=${tgId}`, { headers: { 'x-telegram-id': String(tgId) } })
      .then(r=>r.json()).then(d=>{ console.log('history',d); setData(d) }).catch(e=>console.warn('history fail',e))
  },[])

  const balance = data.transactions?.reduce((s,t)=> s + (t.type==='income'? Number(t.amount) : -Number(t.amount)), 0) || 0
  const refresh = ()=> fetch(`${API}/history?telegram_id=${tgId}`, { headers: { 'x-telegram-id': tgId } }).then(r=>r.json()).then(setData).catch(()=>{})

  // голос прямо из миниапа — без возврата в чат
  const [isRecording, setIsRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false)
  const [voiceResult, setVoiceResult] = useState(null)
  const [voiceError, setVoiceError] = useState(null)
  const mediaRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  const startVoice = async ()=>{
    setVoiceError(null); setVoiceResult(null)
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4' })
      mediaRef.current = mr; chunksRef.current=[]
      mr.ondataavailable = e=>{ if(e.data.size>0) chunksRef.current.push(e.data) }
      mr.onstop = async ()=>{
        stream.getTracks().forEach(t=>t.stop())
        const blob = new Blob(chunksRef.current, { type: mr.mimeType })
        if (!blob.size) return
        setSending(true)
        try{
          const fd = new FormData(); fd.append('file', blob, 'voice.webm')
          window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium')
          const res = await fetch(`${API}/parse`, { method:'POST', headers:{ 'x-telegram-id': String(tgId) }, body: fd }).then(r=>r.json())
          if (res.error) throw new Error(res.details ? `${res.error} | ${res.details.slice(0,200)}` : res.error)
          setVoiceResult(res.parsed)
          await refresh()
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
        }catch(e){ setVoiceError(e.message); window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error') }
        finally{ setSending(false) }
      }
      mr.start(); setIsRecording(true); setSeconds(0)
      timerRef.current = setInterval(()=>setSeconds(s=>s+1),1000)
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('heavy')
    }catch(e){
      setVoiceError(e.name==='NotAllowedError' ? 'Разреши микрофон в браузере' : e.message)
    }
  }
  const stopVoice = ()=>{
    if (mediaRef.current?.state==='recording') mediaRef.current.stop()
    setIsRecording(false); clearInterval(timerRef.current)
  }
  useEffect(()=>()=>clearInterval(timerRef.current),[])

   // динамика столбиков: сумма расходов за последние 7 дней -> высота (МСК)
  const moscowDateStr = (offset=0)=> new Date(Date.now()+offset*86400000).toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'})
  const toMoscowDate = (iso)=> new Date(iso).toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'})
  const last7Expenses = React.useMemo(()=>{
    return Array.from({length:7},(_,k)=>{
      const offset = k-6 // -6 ... 0
      const key = moscowDateStr(offset)
      return (data.transactions||[])
        .filter(t=> t.type==='expense' && toMoscowDate(t.created_at)===key)
        .reduce((s,t)=> s + Number(t.amount||0), 0)
    })
  },[data.transactions])
  const maxExpense = Math.max(...last7Expenses, 1)
  const dayLabels = React.useMemo(()=>{
    const fmt = new Intl.DateTimeFormat('ru-RU',{weekday:'short', timeZone:'Europe/Moscow'})
    return Array.from({length:7},(_,k)=>{
      const d=new Date(); d.setDate(d.getDate()+(k-6))
      return fmt.format(d)
    })
  },[])

  return (
    <div className="min-h-screen relative overflow-hidden p-4 pb-24">
      <div className="gradient-blob" style={{top:-100, left:-80}} />
      <div className="gradient-blob" style={{bottom:100, right:-100, background: 'radial-gradient(circle, #A855F7 0%, transparent 70%)'}} />
      
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-black tracking-tight">FLUX</h1>
        <span className="text-xs px-3 py-1 rounded-full glass">● Online</span>
      </header>

      {tab==='home' && (
        <div className="space-y-4">
          <div onClick={()=>setTab('tracker')} className="glass p-5 cursor-pointer active:scale-[0.98] transition hover:bg-white/10">
            <p className="text-sm opacity-60">Баланс — нажми для истории →</p>
            <p className="text-3xl font-black">{balance.toLocaleString('ru-RU')} ₽</p>
            <div className="mt-4 h-20 flex gap-1.5 items-end">
              {last7Expenses.map((v,i)=>{
                const h = v===0 ? 8 : Math.round((v/maxExpense)*56 + 12) // 12..68px, 0->8px
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      title={`${dayLabels[i]}: ${v} ₽`}
                      style={{height:h}}
                      className="w-full rounded-t-lg bg-gradient-to-t from-[#8B5CF6] to-[#C084FC] opacity-90 transition-all duration-500"
                    />
                    <span className="text-[9px] opacity-40 leading-none">{dayLabels[i]}</span>
                  </div>
                )
              })}
            </div>
            <p className="text-[10px] opacity-40 mt-1">{last7Expenses.some(v=>v>0) ? `макс ${Math.max(...last7Expenses)} ₽ за день` : 'нет расходов за 7 дней — скажи "потратил 500 на обед"'}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div onClick={()=>setTab('calories')} className="glass p-4 cursor-pointer active:scale-[0.97] transition hover:bg-white/10"><p className="text-xs opacity-60">Калории сегодня →</p><p className="text-xl font-bold">{data.calories?.reduce((s,c)=>s+c.kcal,0)||0} ккал</p><p className="text-[10px] opacity-40 mt-1">{data.calories?.length||0} блюд</p></div>
            <div onClick={()=>setTab('tasks')} className="glass p-4 cursor-pointer active:scale-[0.97] transition hover:bg-white/10"><p className="text-xs opacity-60">Задач →</p><p className="text-xl font-bold">{data.notes?.filter(n=>n.kind==='task').length||0}</p><p className="text-[10px] opacity-40 mt-1">нажми для списка</p></div>
          </div>
          <button onClick={()=>{ setTab('voice'); setTimeout(()=>{ if(!isRecording && !sending) startVoice() },150)}} className="w-full btn-gradient py-4 font-bold text-lg">🎙 Голосовой ввод</button>
        </div>
      )}

      {tab==='tracker' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2"><button onClick={()=>setTab('home')} className="text-xs glass px-3 py-1">← Назад</button><h2 className="font-bold">История расходов/доходов</h2></div>
          {(data.transactions?.length||0)===0 ? <p className="text-sm opacity-60 glass p-4 text-center">Пока пусто — скажи “потратил 500 на обед”</p> : data.transactions.slice(0,20).map(t=>(
            <div key={t.id} className="glass p-3 flex justify-between">
              <div><p className="font-semibold">{t.category}</p><p className="text-xs opacity-60">{t.note} • {new Date(t.created_at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})}</p></div>
              <p className={`font-black ${t.type==='expense'?'text-red-400':'text-green-400'}`}>{t.type==='expense'?'-':'+'}{t.amount}₽</p>
            </div>
          ))}
        </div>
      )}

      {tab==='calories' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2"><button onClick={()=>setTab('home')} className="text-xs glass px-3 py-1">← Назад</button><h2 className="font-bold">История калорий</h2></div>
          {(data.calories?.length||0)===0 ? <p className="text-sm opacity-60 glass p-4 text-center">Пока пусто — скажи “съел 2 яйца”</p> : data.calories.slice(0,20).map(c=>(
            <div key={c.id} className="glass p-3 flex justify-between">
              <div><p className="font-semibold">{c.dish}</p><p className="text-xs opacity-60">{new Date(c.created_at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})} • Б:{c.protein||0} Ж:{c.fat||0} У:{c.carbs||0}</p></div>
              <p className="font-black text-orange-400">{c.kcal} ккал</p>
            </div>
          ))}
        </div>
      )}

      {tab==='voice' && (
        <div className="glass p-6 text-center space-y-4">
          <p className="font-bold">{isRecording ? '🎙 Слушаю...' : sending ? '⏳ Отправляю...' : 'Голосовой ввод прямо здесь'}</p>
          <p className="text-sm opacity-70">“потратил 500 на обед” / “съел 2 яйца” / “напомни завтра в 10”</p>

          {!isRecording && !sending ? (
            <button onClick={startVoice} className="w-28 h-28 mx-auto rounded-full btn-gradient flex items-center justify-center text-4xl active:scale-95 transition">🎙</button>
          ) : isRecording ? (
            <button onClick={stopVoice} className="w-28 h-28 mx-auto rounded-full bg-red-500 flex items-center justify-center text-4xl animate-pulse">⏹</button>
          ) : (
            <div className="w-28 h-28 mx-auto rounded-full bg-white/10 flex items-center justify-center">⏳</div>
          )}

          {isRecording && <p className="text-2xl font-mono font-bold">{String(Math.floor(seconds/60)).padStart(2,'0')}:{String(seconds%60).padStart(2,'0')}</p>}
          {sending && <p className="text-xs opacity-60">Распознаю через Whisper...</p>}

          {voiceResult && (
            <div className="glass p-3 text-left text-sm">
              <p className="font-bold">✅ Распознал:</p>
              <pre className="whitespace-pre-wrap text-xs opacity-80">{JSON.stringify(voiceResult,null,2)}</pre>
              <button onClick={()=>{setVoiceResult(null); refresh(); setTab('home')}} className="mt-2 w-full btn-gradient py-2 rounded-xl">OK, к балансу</button>
            </div>
          )}
          {voiceError && <p className="text-sm text-red-400">⚠️ {voiceError}</p>}
          <p className="text-xs opacity-40">Работает без возврата в чат — жми 🎙, говори, жми ⏹. Чат-бот тоже остался как запасной.</p>
        </div>
      )}

      {tab==='tasks' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 mb-2"><button onClick={()=>setTab('home')} className="text-xs glass px-3 py-1">← Назад</button><h2 className="font-bold">Актуальные задачи</h2></div>
          {(data.notes?.filter(n=>n.kind==='task')?.length||0)===0 ? <p className="text-sm opacity-60 glass p-4 text-center">Задач нет — скажи “напомни завтра в 10 позвонить”</p> : data.notes.filter(n=>n.kind==='task').slice(0,20).map(n=>(
            <div key={n.id} className="glass p-3 flex justify-between items-center">
              <div><p className="font-semibold">{n.title}</p><p className="text-xs opacity-60">{n.content||n.kind} • {new Date(n.created_at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})}</p></div>
              <span className={`text-xs px-2 py-1 rounded-full ${n.is_done?'bg-green-500/20 text-green-400':'bg-white/10'}`}>{n.is_done?'✓':'•'}</span>
            </div>
          ))}
          {data.notes?.filter(n=>n.kind!=='task').length>0 && <><h3 className="text-xs opacity-60 mt-3">Заметки/идеи</h3>{data.notes.filter(n=>n.kind!=='task').slice(0,10).map(n=><div key={n.id} className="glass p-3"><p className="font-semibold">{n.title}</p><p className="text-xs opacity-60">{n.kind}</p></div>)}</>}
        </div>
      )}

      <nav className="fixed bottom-3 left-3 right-3 glass flex justify-around py-3">
        {[
          ['home','🏠'], ['tracker','💳'], ['voice','🎙'], ['tasks','✓'], ['settings','⚙️']
        ].map(([id,icon])=>(
          <button key={id} onClick={()=>setTab(id)} className={`w-10 h-10 rounded-2xl flex items-center justify-center ${tab===id?'btn-gradient':''}`}>{icon}</button>
        ))}
      </nav>
    </div>
  )
}
