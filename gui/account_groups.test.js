const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const source=html.slice(html.indexOf('  async function loadAccountGroups()'),html.indexOf('  async function loadNewEdenGraphicsSettings()'));
function setup(characters,save=async()=>({ok:true})) {
  const element=()=>({children:[],style:{},value:'',textContent:'',append(...v){this.children.push(...v);},add(v){this.children.push(v);},setAttribute(){},replaceChildren(){this.children=[];}});
  const host=element(),calls=[];
  const context={document:{getElementById:()=>host,createElement:element},Option:function(text,value){this.text=text;this.value=value;},
    getApi:()=>({get_account_groups:async(...args)=>{assert.equal(args.length,0);return {ok:true,characters};},
      set_character_account_group:async(...args)=>{calls.push(args);return save(...args);}})};
  vm.createContext(context);vm.runInContext(source,context);
  return {host,calls,load:()=>context.loadAccountGroups()};
}
test('empty installation opens settings without SSO',async()=>{
  const t=setup([]);await t.load();assert.match(t.host.textContent,/Aucun personnage/);
});
test('manual assignment sends character and group, clear sends null',async()=>{
  const t=setup([{id:42,name:'Pilot',account_group_id:null}]);await t.load();
  const select=t.host.children[0].children[1];
  select.value='1';await select.onchange();assert.deepEqual(t.calls[0],[42,'1']);assert.equal(select.disabled,false);
  select.value='';await select.onchange();assert.deepEqual(t.calls[1],[42,null]);
});
test('save failure keeps prior group and displays error',async()=>{
  const t=setup([{id:42,name:'Pilot',account_group_id:'2'}],async()=>({ok:false,error:'disk full'}));await t.load();
  const [,select,status]=t.host.children[0].children;
  select.value='1';await select.onchange();assert.equal(select.value,'2');assert.match(status.textContent,/disk full/);
});
