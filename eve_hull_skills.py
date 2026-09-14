"""Direct SDE hull requirements, not recursive skill-training prerequisites."""
PAIRS=((182,277),(183,278),(184,279),(1285,1286),(1289,1287),(1290,1288))

def requirements(row):
    attrs=row.get('dogma_attributes',{})
    result={}
    try:
        for skill,level in PAIRS:
            raw=attrs.get(str(skill),{}).get('value')
            if raw is None:
                continue
            required=attrs.get(str(level),{}).get('value')
            if int(raw)!=raw or int(raw)<=0 or required is None or int(required)!=required or not 1<=required<=5:
                return None
            result[int(raw)]=int(required)
    except (TypeError,ValueError,OverflowError):
        return None
    return result or None

def eligible(required,levels):
    return required is not None and all(levels.get(sid,0)>=level for sid,level in required.items())
