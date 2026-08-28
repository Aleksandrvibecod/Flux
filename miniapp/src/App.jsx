import React, { useEffect, useState, useRef } from 'react'

const API = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

export default function App(){
  const [tab, setTab] = useState('home')
  const [data, setData] = useState({ transactions:[], calories:[], notes:[], streaks:[] })
  const [loading, setLoading] = useState(true)
  const getTgId = ()=> {
    const w = window.Telegram?.WebApp?.initDataUnsafe?.user?.id
    if (w) return w
    const p = new URLSearchParams(window.location.search)
    return Number(p.get('telegram_id') || p.get('tgId') || 0) || 12345
  }
  const tgId = getTgId()
  const [premium, setPremium] = useState({ is_premium:false, expires_at:null, days_left:0 })

  useEffect(()=>{
    setLoading(true)
    Promise.all([
      fetch(`${API}/history?telegram_id=${tgId}`, { headers: { 'x-telegram-id': String(tgId) } }).then(r=>r.json()),
      fetch(`${API}/premium/status?telegram_id=${tgId}`, { headers: { 'x-telegram-id': String(tgId) } }).then(r=>r.json()).catch(()=>({is_premium:false}))
    ]).then(([h,p])=>{ setData(h); setPremium(p); setLoading(false)}).catch(()=>setLoading(false))
  },[])

  const balance = data.transactions?.reduce((s,t)=> s + (t.type==='income'? Number(t.amount) : -Number(t.amount)), 0) || 0
  const refresh = ()=> {
    fetch(`${API}/history?telegram_id=${tgId}`, { headers: { 'x-telegram-id': tgId } }).then(r=>r.json()).then(setData).catch(()=>{})
    fetch(`${API}/premium/status?telegram_id=${tgId}`, { headers: { 'x-telegram-id': String(tgId) } }).then(r=>r.json()).then(setPremium).catch(()=>{})
  }
  const [paying, setPaying] = useState(null)
  const [editingBudget, setEditingBudget] = useState(false)
  const [budgetInput, setBudgetInput] = useState('')
  const saveBudget = async ()=>{
    const v = Number(String(budgetInput).replace(/\D/g,'')); if (!v || v < 1000) { alert('Введите сумму от 1000₽'); return }
    try{
      const res = await fetch(`${API}/budget`, { method:'POST', headers:{'content-type':'application/json','x-telegram-id': String(tgId)}, body: JSON.stringify({ budget: v, telegram_id: tgId }) }).then(r=>r.json())
      if (res.error) throw new Error(res.error + (res.hint? ' — '+res.hint : ''))
      setEditingBudget(false); setBudgetInput(''); await refresh()
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
    }catch(e){ alert('Ошибка сохранения: '+e.message) }
  }
  const buyPlan = async (plan)=>{
    setPaying(plan)
    try{
      const res = await fetch(`${API}/premium/create-invoice`, { method:'POST', headers:{'content-type':'application/json','x-telegram-id': String(tgId)}, body: JSON.stringify({ telegram_id: tgId, plan }) }).then(r=>r.json())
      if (res.error) throw new Error(res.error)
      const link = res.invoiceLink
      if (window.Telegram?.WebApp?.openInvoice){
        window.Telegram.WebApp.openInvoice(link, (status)=>{
          if (status==='paid'){ setTimeout(refresh,1200); window.Telegram.WebApp.HapticFeedback?.notificationOccurred('success') }
          else if (status==='failed') window.Telegram.WebApp.HapticFeedback?.notificationOccurred('error')
        })
      } else {
        window.open(link, '_blank')
      }
    }catch(e){ alert('Ошибка оплаты: '+e.message) }
    finally{ setPaying(null) }
  }

  // быстрый текст
  const [quickText, setQuickText] = useState('')
  const [textSending, setTextSending] = useState(false)
  const sendQuickText = async ()=>{
    if (!quickText.trim()) return
    setTextSending(true)
    try{
      const res = await fetch(`${API}/parse`, { method:'POST', headers:{'content-type':'application/json','x-telegram-id': String(tgId)}, body: JSON.stringify({ text: quickText, telegram_id: tgId }) }).then(r=>r.json())
      if (res.error) throw new Error(res.error)
      setQuickText(''); await refresh()
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
    }catch(e){ alert(e.message) }
    finally{ setTextSending(false) }
  }

  // фильтры и поиск
  const [trackerFilter, setTrackerFilter] = useState('all') // all/expense/income
  const [search, setSearch] = useState('')
  const [chartMode, setChartMode] = useState('week') // week/month
  const [onboardDismissed, setOnboardDismissed] = useState(()=> localStorage.getItem('flux_onboard')==='1')

  const delItem = async (type, id)=>{
    if (!confirm('Удалить?')) return
    const map = { expense:'transactions', income:'transactions', calories:'calories', task:'notes', note:'notes' }
    const path = type==='calories' ? 'calories' : type==='task' || type==='note' ? 'notes' : 'transactions'
    try{
      await fetch(`${API}/${path}/${id}?telegram_id=${tgId}`, { method:'DELETE', headers:{'x-telegram-id': String(tgId)} })
      await refresh()
    }catch{}
  }

  // голос
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
  const receiptRef = useRef(null), foodRef = useRef(null)
  const [photoSending, setPhotoSending] = useState(false)
  const [photoResult, setPhotoResult] = useState(null)
  const handlePhoto = async (file, hint)=>{
    if (!file) return
    setPhotoSending(true); setPhotoResult(null)
    try{
      const fd = new FormData(); fd.append('file', file, file.name); fd.append('text', hint)
      const res = await fetch(`${API}/parse`, { method:'POST', headers:{'x-telegram-id': String(tgId)}, body: fd }).then(r=>r.json())
      if (res.error) throw new Error(res.error)
      setPhotoResult(res); await refresh()
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
    }catch(e){ setPhotoResult({error:e.message}); window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error') }
    finally{ setPhotoSending(false) }
  }

    // динамика столбиков — неделя Пн-Вс (МСК)
  const moscowDateStr = (offset=0)=> new Date(Date.now()+offset*86400000).toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'})
  const toMoscowDate = (iso)=> new Date(iso).toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'})
  const moscowWeekday = ()=> new Date(new Date().toLocaleString('en-US',{timeZone:'Europe/Moscow'})).getDay() // 0 Вс
  const mondayOffset = ()=> {
    const wd = moscowWeekday();
    return wd===0 ? -6 : 1 - wd; // сдвиг до понедельника
  }
  const last7Expenses = React.useMemo(()=>{
    const monOff = mondayOffset();
    return Array.from({length:7},(_,k)=>{
      const offset = monOff + k // Пн(0) .. Вс(6)
      const key = moscowDateStr(offset)
      return (data.transactions||[])
        .filter(t=> t.type==='expense' && toMoscowDate(t.created_at)===key)
        .reduce((s,t)=> s + Number(t.amount||0), 0)
    })
  },[data.transactions])
  // для месяца агрегируем по неделям
  const monthlyExpenses = React.useMemo(()=>{
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const weeks = [0,0,0,0,0]
    ;(data.transactions||[]).filter(t=>t.type==='expense').forEach(t=>{
      const d = new Date(t.created_at)
      if (d.getMonth()!==now.getMonth() || d.getFullYear()!==now.getFullYear()) return
      const w = Math.min(4, Math.floor((d.getDate()-1)/7))
      weeks[w]+=Number(t.amount||0)
    })
    return weeks
  },[data.transactions])
  const chartData = chartMode==='week' ? last7Expenses : monthlyExpenses
  const maxExpense = Math.max(...chartData, 1)
  const dayLabels = React.useMemo(()=>{
    if (chartMode==='month') return ['Нед1','Нед2','Нед3','Нед4','Нед5']
    const monOff = mondayOffset();
    const fmt = new Intl.DateTimeFormat('ru-RU',{weekday:'short', timeZone:'Europe/Moscow'})
    return Array.from({length:7},(_,k)=>{
      const d=new Date(); d.setDate(d.getDate()+(monOff + k))
      return fmt.format(d)
    })
  },[chartMode])

   // бюджет — берем из Supabase, можно менять по клику на историю
  const BUDGET = data.monthly_budget || 20000
  const monthSpent = React.useMemo(()=>{
    const now=new Date(); return (data.transactions||[]).filter(t=>t.type==='expense' && new Date(t.created_at).getMonth()===now.getMonth()).reduce((s,t)=>s+Number(t.amount||0),0)
  },[data.transactions])
  const budgetPct = Math.min(100, Math.round(monthSpent/BUDGET*100))
  // пирог по категориям
  const byCat = React.useMemo(()=>{
    const m={}; (data.transactions||[]).filter(t=>t.type==='expense').forEach(t=>{ const k=t.category||'прочее'; m[k]=(m[k]||0)+Number(t.amount||0) })
    const total = Object.values(m).reduce((a,b)=>a+b,0) || 1
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>({k,v,pct:Math.round(v/total*100)}))
  },[data.transactions])

  const filteredTx = React.useMemo(()=>{
    let arr = data.transactions||[]
    if (trackerFilter!=='all') arr = arr.filter(t=>t.type===trackerFilter)
    if (search) {
      const q=search.toLowerCase()
      arr = arr.filter(t=> (t.category||'').toLowerCase().includes(q) || (t.note||'').toLowerCase().includes(q) || String(t.amount).includes(q))
    }
    return arr
  },[data.transactions, trackerFilter, search])

  return (
    <div className="min-h-screen relative overflow-hidden p-4 pb-24">
      <div className="gradient-blob" style={{top:-100, left:-80}} />
      <div className="gradient-blob" style={{bottom:100, right:-100, background: 'radial-gradient(circle, #A855F7 0%, transparent 70%)'}} />
      
      <header className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-black tracking-tight">FLUX</h1>
          {(() => {
            const s = data.streaks?.find(x=>x.habit==='no_coffee_500')?.streak || 0;
            if (!s) return null;
            return <span className="text-sm px-2 py-0.5 rounded-full glass flex items-center gap-1" title={`${s} дней без кофе`}>{'🔥'.repeat(Math.min(s,5))} {s}д</span>
          })()}
        </div>
        <span className="text-xs px-3 py-1 rounded-full glass">● Online</span>
      </header>

      {loading && <div className="space-y-3 animate-pulse"><div className="glass h-32"/><div className="glass h-20"/></div>}

      {!loading && !onboardDismissed && (data.transactions?.length||0)===0 && (
        <div className="glass p-4 mb-4 space-y-2 border border-[#8B5CF6]/30">
          <p className="font-bold">👋 Привет! 3 примера:</p>
          <p className="text-xs opacity-80">• “Потратил 500 на обед” • “Съел борщ 350 ккал” • “Напомни завтра в 10”</p>
          <p className="text-xs opacity-60">Пиши текстом ниже, голосом или фото. Попробуй сейчас:</p>
          <button onClick={()=>{setOnboardDismissed(true); localStorage.setItem('flux_onboard','1')}} className="w-full btn-gradient py-2 rounded-xl text-sm">Понятно</button>
        </div>
      )}

      {tab==='home' && !loading && (
        <div className="space-y-4">
          {/* быстрый ввод текста */}
          <div className="glass p-3 flex gap-2">
            <input value={quickText} onChange={e=>setQuickText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&sendQuickText()} placeholder="Потратил 500 на обед..." className="flex-1 bg-transparent outline-none text-sm placeholder:opacity-40" />
            <button onClick={sendQuickText} disabled={textSending || !quickText.trim()} className="px-4 py-1.5 rounded-full btn-gradient text-sm font-bold disabled:opacity-40">{textSending?'...':'ОК'}</button>
          </div>

          <div onClick={()=>setTab('tracker')} className="glass p-5 cursor-pointer active:scale-[0.98] transition hover:bg-white/10">
            <div className="flex justify-between items-center">
              <p className="text-sm opacity-60">Баланс — нажми для истории →</p>
              <div className="flex gap-1 text-[10px]">
                <button onClick={(e)=>{e.stopPropagation(); setChartMode('week')}} className={`px-2 py-0.5 rounded-full ${chartMode==='week'?'bg-white text-black':'glass'}`}>Неделя</button>
                <button onClick={(e)=>{e.stopPropagation(); setChartMode('month')}} className={`px-2 py-0.5 rounded-full ${chartMode==='month'?'bg-white text-black':'glass'}`}>Месяц</button>
              </div>
            </div>
            <p className="text-3xl font-black">{balance.toLocaleString('ru-RU')} ₽</p>
            <div className="mt-4 h-20 flex gap-1.5 items-end">
              {chartData.map((v,i)=>{
                const h = v===0 ? 8 : Math.round((v/maxExpense)*56 + 12)
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div title={`${dayLabels[i]}: ${v} ₽`} style={{height:h}} className="w-full rounded-t-lg bg-gradient-to-t from-[#8B5CF6] to-[#C084FC] opacity-90 transition-all duration-500" />
                    <span className="text-[9px] opacity-40 leading-none">{dayLabels[i]}</span>
                  </div>
                )
              })}
            </div>
            <p className="text-[10px] opacity-40 mt-1">{chartData.some(v=>v>0) ? `макс ${Math.max(...chartData)} ₽` : 'нет расходов — добавь через ввод выше'}</p>
            {/* бюджет — клик для выбора */}
            <div className="mt-3" onClick={(e)=>{e.stopPropagation(); setBudgetInput(String(BUDGET)); setEditingBudget(true)}}>
              <div className="flex justify-between text-[10px] opacity-60"><span>Бюджет месяца — нажми чтобы изменить →</span><span>{monthSpent.toLocaleString('ru-RU')} / {BUDGET.toLocaleString('ru-RU')} ₽ {budgetPct}%</span></div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden mt-1"><div className={`h-1.5 rounded-full transition-all ${budgetPct>90?'bg-red-500':budgetPct>70?'bg-yellow-400':'bg-gradient-to-r from-[#8B5CF6] to-[#C084FC]'}`} style={{width:`${budgetPct}%`}} /></div>
            </div>
            {editingBudget && (
              <div className="glass p-3 flex gap-2 items-center overflow-hidden">
                <input value={budgetInput} onChange={e=>setBudgetInput(e.target.value)} type="number" placeholder="20000" className="flex-1 min-w-0 bg-transparent border border-white/20 rounded-lg px-3 py-1.5 text-sm outline-none" autoFocus />
                <button onClick={saveBudget} className="shrink-0 px-4 py-1.5 rounded-full btn-gradient text-sm font-bold">ОК</button>
                <button onClick={()=>setEditingBudget(false)} className="shrink-0 w-8 h-8 flex items-center justify-center glass rounded-full text-sm">✕</button>
              </div>
            )}
            {/* пирог */}
            {byCat.length>0 && (
              <div className="mt-3 flex gap-2 flex-wrap">
                {byCat.map(c=>(
                  <span key={c.k} className="text-[10px] glass px-2 py-1 rounded-full">{c.k} {c.pct}%</span>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div onClick={()=>setTab('calories')} className="glass p-4 cursor-pointer active:scale-[0.97] transition hover:bg-white/10"><p className="text-xs opacity-60">Калории сегодня →</p><p className="text-xl font-bold">{data.calories?.reduce((s,c)=>s+c.kcal,0)||0} ккал</p><p className="text-[10px] opacity-40 mt-1">{data.calories?.length||0} блюд</p></div>
            <div onClick={()=>setTab('tasks')} className="glass p-4 cursor-pointer active:scale-[0.97] transition hover:bg-white/10"><p className="text-xs opacity-60">Задач →</p><p className="text-xl font-bold">{data.notes?.filter(n=>n.kind==='task').length||0}</p><p className="text-[10px] opacity-40 mt-1">нажми для списка</p></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input ref={receiptRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e=>handlePhoto(e.target.files[0], 'чек')} />
            <input ref={foodRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e=>handlePhoto(e.target.files[0], 'еда')} />
            <button onClick={()=>receiptRef.current?.click()} disabled={photoSending} className="glass py-3 rounded-xl text-sm font-semibold active:scale-95 transition">📸 Сканер чека</button>
            <button onClick={()=>foodRef.current?.click()} disabled={photoSending} className="glass py-3 rounded-xl text-sm font-semibold active:scale-95 transition">🍲 Фото еды</button>
          </div>
          {photoSending && <p className="text-xs opacity-60 text-center">⏳ Распознаю...</p>}
          {photoResult && (
            <div className="glass p-3 text-xs">
              {photoResult.error ? <p className="text-red-400">⚠️ {photoResult.error}</p> : <><p className="font-bold">✅ {photoResult.parsed?.type==='receipt' ? `Чек ${photoResult.saved?.shop||''} ${photoResult.saved?.total||''}₽` : photoResult.parsed?.dish ? `${photoResult.parsed.dish} ${photoResult.parsed.kcal} ккал` : 'Готово'}</p><pre className="whitespace-pre-wrap opacity-60 mt-1">{JSON.stringify(photoResult.parsed,null,2).slice(0,300)}</pre></>}
              <button onClick={()=>setPhotoResult(null)} className="mt-2 w-full glass py-1 rounded-lg">OK</button>
            </div>
          )}
          <button onClick={()=>setTab('settings')} className="mx-auto block px-5 py-2.5 rounded-full glass text-sm font-semibold opacity-80 hover:opacity-100 active:scale-95 transition">💎 Перейти на Премиум</button>
          <p className="text-[10px] opacity-40 text-center">Безлимит голос/текст, 365д истории, сводка 22:00</p>
          <p className="text-[10px] opacity-20 text-center tracking-widest mt-1">by. P0dp1Vasn1K</p>
        </div>
      )}

      {tab==='tracker' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2"><button onClick={()=>setTab('home')} className="text-xs glass px-3 py-1">← Назад</button><h2 className="font-bold">История</h2></div>
          <div onClick={()=>{setBudgetInput(String(BUDGET)); setEditingBudget(true)}} className="glass p-3 cursor-pointer active:scale-[0.98] transition">
            <div className="flex justify-between text-xs"><span>Бюджет месяца — изменить →</span><span className="font-bold">{monthSpent.toLocaleString('ru-RU')} / {BUDGET.toLocaleString('ru-RU')} ₽</span></div>
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden mt-2"><div className={`h-1.5 rounded-full ${budgetPct>90?'bg-red-500':budgetPct>70?'bg-yellow-400':'bg-gradient-to-r from-[#8B5CF6] to-[#C084FC]'}`} style={{width:`${budgetPct}%`}} /></div>
            <p className="text-[10px] opacity-40 mt-1">{budgetPct}% израсходовано • нажми чтобы задать свой лимит</p>
          </div>
          {editingBudget && (
            <div className="glass p-3 flex gap-2 items-center overflow-hidden">
              <input value={budgetInput} onChange={e=>setBudgetInput(e.target.value)} type="number" placeholder="20000" className="flex-1 min-w-0 bg-transparent border border-white/20 rounded-lg px-3 py-1.5 text-sm outline-none" autoFocus />
              <button onClick={saveBudget} className="shrink-0 px-4 py-1.5 rounded-full btn-gradient text-sm font-bold">ОК</button>
              <button onClick={()=>setEditingBudget(false)} className="shrink-0 w-8 h-8 flex items-center justify-center glass rounded-full text-sm">✕</button>
            </div>
          )}
          <div className="flex gap-1">
            {['all','expense','income'].map(f=>(
              <button key={f} onClick={()=>setTrackerFilter(f)} className={`text-xs px-3 py-1 rounded-full ${trackerFilter===f?'bg-white text-black':'glass'}`}>{f==='all'?'Все':f==='expense'?'Расходы':'Доходы'}</button>
            ))}
          </div>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск по категории/заметке..." className="w-full glass p-2 text-sm outline-none" />
          {filteredTx.length===0 ? <p className="text-sm opacity-60 glass p-4 text-center">Ничего не найдено</p> : filteredTx.slice(0,20).map(t=>(
            <div key={t.id} className="glass p-3 flex justify-between items-center">
              <div onClick={()=>setSearch(t.category)} className="flex-1 cursor-pointer"><p className="font-semibold">{t.category}</p><p className="text-xs opacity-60">{t.note} • {new Date(t.created_at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})}</p></div>
              <div className="flex items-center gap-2">
                <p className={`font-black ${t.type==='expense'?'text-red-400':'text-green-400'}`}>{t.type==='expense'?'-':'+'}{t.amount}₽</p>
                <button onClick={()=>delItem(t.type,t.id)} className="text-xs opacity-40 hover:opacity-100">🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab==='calories' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2"><button onClick={()=>setTab('home')} className="text-xs glass px-3 py-1">← Назад</button><h2 className="font-bold">История калорий</h2></div>
          {(data.calories?.length||0)===0 ? <p className="text-sm opacity-60 glass p-4 text-center">Пока пусто — скажи “съел 2 яйца”</p> : data.calories.slice(0,20).map(c=>(
            <div key={c.id} className="glass p-3 flex justify-between items-center">
              <div><p className="font-semibold">{c.dish}</p><p className="text-xs opacity-60">{new Date(c.created_at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})} • Б:{c.protein||0} Ж:{c.fat||0} У:{c.carbs||0}</p></div>
              <div className="flex items-center gap-2"><p className="font-black text-orange-400">{c.kcal} ккал</p><button onClick={()=>delItem('calories',c.id)} className="text-xs opacity-40">🗑</button></div>
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
          {data.notes?.filter(n=>n.kind!=='task').length>0 && <><h3 className="text-xs opacity-60 mt-3">Заметки/идеи</h3>{data.notes.filter(n=>n.kind!=='task').slice(0,10).map(n=><div key={n.id} className="glass p-3 flex justify-between"><p className="font-semibold">{n.title}</p><p className="text-xs opacity-60">{n.kind}</p><button onClick={()=>delItem(n.kind,n.id)} className="text-xs opacity-40">🗑</button></div>)}</>}
        </div>
      )}

      {tab==='settings' && (
        <div className="space-y-4">
          <h2 className="font-bold">⚙️ Подписка</h2>
          <div className="glass p-4">
            {premium.is_premium ? (
              <div className="space-y-2">
                <p className="text-sm font-bold text-green-400">✅ Premium активен</p>
                <p className="text-2xl font-black">{premium.days_left} дней осталось</p>
                <p className="text-xs opacity-60">до {premium.expires_at ? new Date(premium.expires_at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}) : '—'} • {premium.provider}</p>
                <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden"><div className="h-2 bg-gradient-to-r from-[#8B5CF6] to-[#C084FC]" style={{width: `${Math.min(100, (premium.days_left/30)*100)}%`}} /></div>
                <p className="text-[11px] opacity-60">При продлении срок добавляется к текущему — не сгорает. Оплатил сейчас +30д к {premium.days_left}д.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-bold">Free</p>
                <p className="text-xs opacity-60">2 голоса + 5 текстов в день, 7 дней истории, без ИИ-сводки</p>
                <p className="text-xs opacity-80">💎 Premium снимает все лимиты: безлимит, 365д истории, сводка 22:00</p>
              </div>
            )}
          </div>
          <p className="text-xs font-bold opacity-80">Продлить / купить:</p>
          {[
            {id:'1m', title:'1 месяц', price:'250 Stars (~299₽)', sub:'30 дней', badge:''},
            {id:'3m', title:'3 месяца', price:'650 Stars • 799₽', sub:'90 дней', badge:'-11% 🔥'},
            {id:'6m', title:'6 месяцев', price:'1300 Stars • 1599₽', sub:'180 дней', badge:'-16% ⭐'},
          ].map(p=>(
            <button key={p.id} onClick={()=>buyPlan(p.id)} disabled={!!paying} className="w-full glass p-4 flex justify-between items-center active:scale-[0.98] transition hover:bg-white/10 text-left">
              <div><p className="font-bold">{p.title} {p.badge && <span className="text-xs bg-[#8B5CF6] px-2 py-0.5 rounded-full ml-1">{p.badge}</span>}</p><p className="text-xs opacity-60">{p.sub} • {p.price}</p></div>
              <span className="btn-gradient px-4 py-2 rounded-xl text-sm font-bold">{paying===p.id ? '⏳' : 'Купить'}</span>
            </button>
          ))}
          <p className="text-[10px] opacity-40 text-center">Оплата Stars через Telegram • чек в чате • после оплаты Premium включится автоматом</p>
          <button onClick={refresh} className="w-full text-xs glass py-2">🔄 Обновить статус</button>
          <a
            href="https://t.me/p0dp1vas"
            onClick={(e)=>{ e.preventDefault(); const url='https://t.me/p0dp1vas'; if(window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url); else if(window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(url); else window.open(url,'_blank'); }}
            className="w-full glass py-3 rounded-xl text-sm font-semibold text-center block active:scale-95 transition hover:bg-white/10"
          >💬 Поддержка</a>
          <p className="text-[10px] opacity-30 text-center">напиши @p0dp1vas если что-то не работает</p>
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
