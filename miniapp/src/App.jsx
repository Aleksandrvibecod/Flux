import React, { useEffect, useState } from 'react'

const API = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000'

export default function App(){
  const [tab, setTab] = useState('home')
  const [data, setData] = useState({ transactions:[], calories:[], notes:[] })
  const tgId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id || 12345

  useEffect(()=>{
    fetch(`${API}/history?telegram_id=${tgId}`, { headers: { 'x-telegram-id': tgId } })
      .then(r=>r.json()).then(setData).catch(()=>{})
  },[])

  const balance = data.transactions?.reduce((s,t)=> s + (t.type==='income'? t.amount : -t.amount), 0) || 0

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
          <div className="glass p-5">
            <p className="text-sm opacity-60">Баланс</p>
            <p className="text-3xl font-black">{balance.toLocaleString('ru-RU')} ₽</p>
            <div className="mt-4 h-16 flex gap-1 items-end">
              {[12,18,9,22,16,20,14].map((h,i)=><div key={i} style={{height:h*3}} className="flex-1 rounded-t-lg bg-gradient-to-t from-[#8B5CF6] to-[#C084FC] opacity-80"/>)}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="glass p-4"><p className="text-xs opacity-60">Калории сегодня</p><p className="text-xl font-bold">{data.calories?.reduce((s,c)=>s+c.kcal,0)||0} ккал</p></div>
            <div className="glass p-4"><p className="text-xs opacity-60">Задач</p><p className="text-xl font-bold">{data.notes?.filter(n=>n.kind==='task').length||0}</p></div>
          </div>
          <button onClick={()=>setTab('voice')} className="w-full btn-gradient py-4 font-bold text-lg">🎙 Голосовой ввод</button>
        </div>
      )}

      {tab==='tracker' && (
        <div className="space-y-3">
          <h2 className="font-bold">История</h2>
          {data.transactions?.slice(0,10).map(t=>(
            <div key={t.id} className="glass p-3 flex justify-between">
              <div><p className="font-semibold">{t.category}</p><p className="text-xs opacity-60">{t.note}</p></div>
              <p className={`font-black ${t.type==='expense'?'text-red-400':'text-green-400'}`}>{t.type==='expense'?'-':'+'}{t.amount}₽</p>
            </div>
          ))}
        </div>
      )}

      {tab==='voice' && (
        <div className="glass p-6 text-center space-y-4">
          <p className="font-bold">Скажи голосом боту</p>
          <p className="text-sm opacity-70">“потратил 500 на обед” / “съел 2 яйца” / “напомни завтра в 10”</p>
          <p className="text-xs opacity-50">Открой бота в Telegram и зажми 🎙</p>
        </div>
      )}

      {tab==='tasks' && (
        <div className="space-y-2">
          {data.notes?.map(n=>(
            <div key={n.id} className="glass p-3"><p className="font-semibold">{n.title}</p><p className="text-xs opacity-60">{n.kind}</p></div>
          ))}
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
