import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {EventEmitter} from 'node:events';
export class CodexRpc extends EventEmitter{
 constructor({binary=process.env.CODEX_BINARY||'codex',home,env=process.env}={}){super();this.next=1;this.pending=new Map();const clean={};for(const key of ['PATH','HOME','USER','TMPDIR','TEMP','SystemRoot','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR'])if(env[key])clean[key]=env[key];if(home)clean.CODEX_HOME=home;
 this.child=spawn(binary,['app-server','--stdio'],{env:clean,stdio:['pipe','pipe','pipe']});this.child.stderr.on('data',()=>{});this.child.on('error',e=>this.fail(e));this.child.on('exit',()=>this.fail(new Error('Codex app-server stopped')));
 createInterface({input:this.child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line)}catch{return}if(message.id!==undefined&&!message.method){const p=this.pending.get(message.id);if(p){this.pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(message.error.message||'Codex request failed')):p.resolve(message.result)}}else this.emit(message.id!==undefined?'request':'notification',message)});
 }
 send(message){this.child.stdin.write(JSON.stringify(message)+'\n')}
 request(method,params={}){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex request timed out: '+method))},30000);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params})})}
 reply(id,result){this.send({id,result})}
 reject(id){this.send({id,error:{code:-32601,message:'This operation is not supported by CODEX CONVOS'}})}
 async initialize(){await this.request('initialize',{clientInfo:{name:'codex_convos',title:'CODEX CONVOS',version:'0.1.0'}});this.send({method:'initialized'});}
 fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear();this.emit('closed',error)}
 close(){this.child.kill('SIGTERM')}
}
