import { readSelfConfig } from "./config.mjs";
// The fragment stays in the client/LINE card. No PIN, owner or session token is
// placed in the HTTP query, and clicking this URI never fabricates a receipt.
export function linkConfirmationMessage(ctx, store, pin, expiresAt) {
  const fragment = new URLSearchParams({"line-confirm":pin,store:store.id,expires:String(expiresAt)});
  const uri = readSelfConfig(ctx.env).origin + "/start?openExternalBrowser=1#" + fragment;
  return {type:"flex",altText:"MEO Harness：確認して登録画面へ進む",contents:{
    type:"bubble",body:{type:"box",layout:"vertical",contents:[
      {type:"text",text:"通知先のLINEを確認",weight:"bold",wrap:true},
      {type:"text",text:store.title.slice(0,300),wrap:true},
      {type:"text",text:"5分以内に確認してください。ご本人が始めた登録だけが対象です。心当たりがなければ押さないでください。リンクの転送は禁止です。",wrap:true},
      {type:"text",text:`必要な場合の確認番号: ${pin}\n元の登録ブラウザで6桁を入力して確認できます。`,size:"sm",wrap:true},
    ]},footer:{type:"box",layout:"vertical",contents:[
      {type:"button",style:"primary",action:{type:"uri",label:"確認して登録画面へ進む",uri}},
    ]},
  }};
}
