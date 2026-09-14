"""Route exposure, not a replacement for the map's system danger score.

Existing ESI/live scores are inputs. Nearby live signals have double weight;
attenuation halves per hop beyond the first. Bounded to three stargate hops.
For one neighboring system use the stronger signal, not both, avoiding counting
the same combat twice. No network or renderer work.
"""
RISK_RADIUS = 3

def proximity_risk(system_id, adjacency, scores):
    seen={system_id};frontier=[system_id];total=0;contributors=[]
    for hops in range(1,RISK_RADIUS+1):
        following=[]
        for source in frontier:
            for target in sorted(adjacency.get(source,())):
                if target in seen:
                    continue
                seen.add(target);following.append(target)
                row=scores.get(target,{})
                value=max(row.get('esi_score',0),2*row.get('recent_score',0))/(2**(hops-1))
                if value>0:
                    contributors.append({'system_id':target,'hops':hops,'risk':value})
                    total+=value
        frontier=following
    return {'risk':total,'contributors':contributors}
